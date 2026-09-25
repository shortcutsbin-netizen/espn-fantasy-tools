/**
 * FortuneTellerDO: runs a Fortune Teller build as governed slices, one team per
 * alarm, and writes the stores to R2. It serves no page requests (pages read
 * R2), so a long slice never blocks a reader.
 *
 * The governor caps the build's share of each free daily quota, paces that
 * share through the UTC day and releases the remainder in a burst before the
 * 00:00 UTC reset, and holds slices while NFL games are in their windows.
 * Everything is metered here, since nothing reports account usage to a Worker.
 */
import { buildTeam, buildTeamPart, mergeParts, finishFromPart, partPlan, assembleSummary, deflateRaw, pathCount, PATH_CEILING } from './ftbuild.js';
import { FT_SUMMARY_KEY, ftMapKey } from './fortuneteller.js';
import { getPart } from './store.js';
import { FT_DEV_VIEW_KEY, FT_ESPN_ODDS_KEY } from './fortuneteller.js';
import { loadConfig } from './config.js';
import { fetchPart } from './espn.js';
import { simplestPath, totalsOf } from '../app/fortune-teller/engine.js';
import { finalOdds } from '../app/fortune-teller/final.js';
import { leagueState, readiness, buildRealInput, treeFingerprint, newTrims, projectedTotals, leagueUrl, gameChances } from './ftleague.js';

export const FT_PIPELINE_KEY = 'fortune-teller/pipeline.json';
export const FT_DEV_LEAGUE_KEY = 'fortune-teller/dev-league.json';
async function inflateBytes(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }

// Measured: even a 12-team build uses under 2% of any daily quota, so builds run at
// full speed by default; the allowance and pacing remain as a backstop.
export const FT_ACTIVE_KEY = 'fortune-teller/build-active';
export const FT_DEFAULTS = { allowancePct: 50, sliceGapMs: 150, gameGate: true, burst: true, burstHour: 23, paceFloor: 1, activateOnFinish: true,
  targetSliceMs: 10000, nsFast: 130, nsH2h: 1900, nsDiv: 4500, partDigits: -1 };
async function inflateRaw(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
const FREE = { requests: 100000, gbs: 13000, rows: 100000 };
const LOG_MAX = 150;

export class FortuneTellerDO {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.now = () => Date.now(); }
  s() { return this.ctx.storage; }
  async config() { return { ...FT_DEFAULTS, ...((await this.s().get('config')) || {}) }; }
  async log(level, msg) {
    const l = (await this.s().get('log')) || []; l.push({ at: new Date(this.now()).toISOString(), level, msg });
    await this.s().put('log', l.slice(-LOG_MAX)); this.rows = (this.rows || 0) + 1;
  }
  async meter(day) { return (await this.s().get('meter:' + day)) || { day, alarms: 0, wallMs: 0, rows: 0 }; }

  /** Whether a slice may run now, and if not, why and until when. */
  async governor(cfg) {
    const now = this.now(), d = new Date(now), day = d.toISOString().slice(0, 10), m = await this.meter(day);
    const pct = Math.max(1, Math.min(100, cfg.allowancePct)) / 100;
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    const pace = cfg.burst ? (hour >= cfg.burstHour ? 1 : Math.max(cfg.paceFloor, hour / cfg.burstHour)) : 1;
    const used = { requests: m.alarms / (FREE.requests * pct), gbs: (m.wallMs / 1000) * 0.125 / (FREE.gbs * pct), rows: m.rows / (FREE.rows * pct) };
    const worst = Math.max(used.requests, used.gbs, used.rows);
    const nextDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5);
    if (worst >= 1) return { ok: false, reason: 'daily allowance spent', until: nextDay, pace, used };
    if (worst >= pace) return { ok: false, reason: `paced: ${Math.round(worst * 100)}% of today's allowance used, ${Math.round(pace * 100)}% released so far`, until: Math.min(now + 15 * 60000, nextDay), pace, used };
    if (cfg.gameGate) {
      const gate = await this.gameWindow(now);
      if (gate) return { ok: false, reason: `NFL game window (kickoff ${gate.kickoff})`, until: gate.until, pace, used };
    }
    return { ok: true, pace, used };
  }
  async gameWindow(now) {
    try {
      const o = await getPart(this.env, 'bye_weeks', 'main'); if (!o) return null;
      const d = await o.json(); const k = (d && d.kickoffs) || {};
      let hit = null;
      for (const team of Object.keys(k)) for (const iso of Object.values(k[team])) {
        const t = Date.parse(iso); if (!(t > 0)) continue;
        if (now >= t - 15 * 60000 && now < t + 4 * 3600000) { const until = t + 4 * 3600000; if (!hit || until > hit.until) hit = { kickoff: iso, until }; }
      }
      return hit;
    } catch { return null; }
  }

  // ── The production pipeline ──────────────────────────────────────────────────
  /** The real league from stored datasets; on dev only, a simulated league may stand in. */
  async leagueSource() {
    if (this.env.DEV_TOKEN) { const o = await this.env.DATA.get(FT_DEV_LEAGUE_KEY); if (o) { const d = await o.json(); return { ...d, names: new Map(d.names || []), dev: true }; } }
    const read = async (k) => { try { const o = await getPart(this.env, k, 'main'); return o ? await o.json() : null; } catch { return null; } };
    const [sched, settingsRaw, teamsRaw, st] = await Promise.all([read('season_schedule'), read('league_settings'), read('league_teams'), read('standings_digest')]);
    if (!sched || !settingsRaw) return null;
    return { sched, settingsRaw, teamsRaw, names: new Map(((st && st.rows) || []).map((r) => [Number(r.teamId ?? r.id), r.name])) };
  }

  /** ESPN's projected totals for the window's future weeks (this week uses ESPN's own win probability). */
  async projections(src, cfg, weeks, current) {
    const out = new Map();
    if (src.dev) { for (const [w, m] of Object.entries(src.projections || {})) out.set(Number(w), new Map(Object.entries(m).map(([k, v]) => [Number(k), v]))); return out; }
    const slotCounts = ((src.settingsRaw.settings || src.settingsRaw).rosterSettings || {}).lineupSlotCounts || {};
    for (const w of weeks) {
      if (w <= current) continue;
      const r = await fetchPart(cfg, { url: leagueUrl(cfg, `?view=mRoster&scoringPeriodId=${w}`) }, { auth: true });
      if (!r.ok || !r.buffer) continue;
      try { out.set(w, projectedTotals(JSON.parse(new TextDecoder().decode(r.buffer)), w, slotCounts)); } catch { /* season averages stand in */ }
    }
    return out;
  }

  /* ESPN can only say what its playoff odds are now, never what they were, so the pipeline
     keeps them: one entry per settled week, the latest value while the next week is played. */
  async recordEspnOdds(season, week) {
    const o = await getPart(this.env, 'standings_digest', 'main'); if (!o) return;
    const d = await o.json(), odds = {};
    for (const r of (d && d.rows) || []) if (typeof r.playoffPct === 'number') odds[r.teamId] = +r.playoffPct.toFixed(4);
    if (!Object.keys(odds).length) return;
    let h = null; try { const x = await this.env.DATA.get(FT_ESPN_ODDS_KEY); h = x ? await x.json() : null; } catch { h = null; }
    if (!h || h.season !== season) h = { season, weeks: {} };
    if (JSON.stringify(h.weeks[String(week)]) === JSON.stringify(odds)) return;
    h.weeks[String(week)] = odds; h.updatedAt = new Date(this.now()).toISOString();
    await this.env.DATA.put(FT_ESPN_ODDS_KEY, JSON.stringify(h), { httpMetadata: { contentType: 'application/json' } });
  }

  async activeSummary() { try { const o = await this.env.DATA.get(FT_SUMMARY_KEY); return o ? await o.json() : null; } catch { return null; } }
  /* The pipeline's own tree lives in the library and is the source of truth; what is live is
     a copy. On dev a manual choice of what is live pins it, and the pipeline then keeps its
     tree current in the library without touching what is live. Production is never pinned. */
  async pinned() {
    if (!this.env.DEV_TOKEN) return false;
    try { const o = await this.env.DATA.get(FT_DEV_VIEW_KEY); if (!o) return false; const v = await o.json(); return !!v && v.view !== 'live'; } catch { return false; }
  }
  async pipelineSummary() {
    const t = await this.s().get('ptree'); if (!t) return null;
    try { const o = await this.env.DATA.get(`${t.prefix}summary.json`); return o ? await o.json() : null; } catch { return null; }
  }
  async activateTree(prefix, summary) {
    const live = await this.activeSummary();
    if (!live || live.datasetId !== summary.datasetId) for (const m of summary.maps || []) { const o = await this.env.DATA.get(`${prefix}maps/${m.teamId}.bin`); if (o) await this.env.DATA.put(ftMapKey(m.teamId), await o.arrayBuffer()); }
    await this.env.DATA.put(FT_SUMMARY_KEY, JSON.stringify({ ...summary, activeTrim: summary.activeTrim ?? summary.trims.length - 1 }), { httpMetadata: { contentType: 'application/json' } });
  }

  /** Dev: every team's odds for every week of a dataset built before the build recorded them, counted from its maps. */
  async backfillOdds(id) {
    const prefix = `fortune-teller/library/${id}/`, o = await this.env.DATA.get(`${prefix}summary.json`);
    if (!o) return { ok: false, error: `no dataset ${id}` };
    const s = await o.json(), G = s.games.length, odds = s.trims.map(() => new Array(s.teams.length).fill(null)), t0 = Date.now();
    for (let i = 0; i < s.teams.length; i++) {
      const mo = await this.env.DATA.get(`${prefix}maps/${s.teams[i].id}.bin`); if (!mo) continue;
      const raw = await inflateBytes(new Uint8Array(await mo.arrayBuffer())), meta = s.maps[i];
      const map = { nodes: new Int32Array(raw.buffer, raw.byteOffset, raw.length / 4), root: meta.root, G, leafBase: meta.leafBase || 256, leaves: meta.leaves || null };
      s.trims.forEach((tr, k) => { const pins = new Int8Array(G).fill(-1); for (let j = 0; j < tr.fixed; j++) pins[j] = s.future[j].digit; const t = totalsOf(map, pins, s.places, 0); odds[k][i] = +(t[1] / t[0]).toFixed(6); });
    }
    s.trims.forEach((tr, k) => { tr.odds = finalOdds(s, tr) || odds[k]; });
    await this.env.DATA.put(`${prefix}summary.json`, JSON.stringify(s), { httpMetadata: { contentType: 'application/json' } });
    const live = await this.activeSummary();
    if (live && live.datasetId === id) { live.trims.forEach((tr, k) => { tr.odds = s.trims[k].odds; }); await this.env.DATA.put(FT_SUMMARY_KEY, JSON.stringify(live), { httpMetadata: { contentType: 'application/json' } }); }
    return { ok: true, id, ms: Date.now() - t0, sums: odds.map((a) => +a.reduce((x, v) => x + (v || 0), 0).toFixed(4)) };
  }

  /** Dev: the real input and ESPN's projections, fetched inside this object, without building anything. */
  async dryRun() {
    const cfg = await loadConfig(this.env, { fresh: true }), src = await this.leagueSource();
    if (!src) return { ok: false, error: 'the league has not been pulled yet' };
    const st = leagueState(src.sched, src.settingsRaw), season = Number(cfg.season || src.settingsRaw.seasonId);
    const weeks = Array.from({ length: st.mpc - st.lastSettled }, (_, k) => st.lastSettled + 1 + k), t0 = Date.now();
    const proj = await this.projections(src, cfg, weeks, st.current);
    const input = buildRealInput({ ...src, projections: proj, season }, st.lastSettled + 1);
    const sources = {}; for (const g of input.games) sources[g.source] = (sources[g.source] || 0) + 1;
    return { ok: true, dev: !!src.dev, lastSettled: st.lastSettled, current: st.current, mpc: st.mpc, fetchMs: Date.now() - t0, projectedWeeks: [...proj.keys()],
      totals: Object.fromEntries([...proj].slice(0, 2).map(([w, m]) => [w, Object.fromEntries([...m].map(([id, v]) => [(src.names && src.names.get(id)) || id, v]))])),
      games: input.games.length, sources, sample: input.games.filter((g, i) => i < 3 || g.source === 'projection').slice(0, 6).map((g) => ({ week: g.week, a: src.names.get(g.a) || g.a, b: src.names.get(g.b) || g.b, pA: g.pA, projA: g.projA, projB: g.projB, source: g.source })),
      fingerprint: input.fingerprint };
  }
  async putPipeline(p) { await this.env.DATA.put(FT_PIPELINE_KEY, JSON.stringify(p), { httpMetadata: { contentType: 'application/json' } }); return p; }

  /**
   * Decides what Fortune Teller should be doing, and starts it. Runs from the site's cron
   * every 15 minutes and whenever an admin changes the setting. States: early (a build does
   * not fit yet), available (it fits; waiting for an admin), building, updating (a week
   * settled), ready, season-over, failed, no-data.
   */
  async runPipeline(reason = 'check', force = false, enabledNow = null) {
    // A caller that has just changed the setting says what it is: KV can take up to a minute
    // to show a save everywhere, and this object may be running somewhere else.
    const s = this.s(), now = this.now(), cfg = await loadConfig(this.env, { fresh: true });
    const enabled = enabledNow != null ? enabledNow : !!(cfg.fortuneTeller && cfg.fortuneTeller.enabled), gov = await this.config();
    const src = await this.leagueSource();
    const prev = (await (async () => { try { const o = await this.env.DATA.get(FT_PIPELINE_KEY); return o ? await o.json() : null; } catch { return null; } })()) || {};
    const out = { checkedAt: new Date(now).toISOString(), enabled, reason, attempts: prev.attempts || 0 };
    if (!src) return this.putPipeline({ ...out, state: 'no-data' });
    const st = leagueState(src.sched, src.settingsRaw), season = Number(cfg.season || src.settingsRaw.seasonId || src.season), ready = readiness(st, gov.allowancePct);
    if (!src.dev) { try { await this.recordEspnOdds(season, st.lastSettled); } catch (e) { await this.log('warn', `recording ESPN's odds failed: ${String((e && e.message) || e)}`); } }
    Object.assign(out, { season, mpc: st.mpc, lastSettled: st.lastSettled, weeksLeft: st.weeksLeft, opensAfterWeek: ready.opensAfterWeek, dev: !!src.dev,
      estimate: ready.estimate ? { hours: ready.estimate.hours, paths: ready.estimate.paths } : null });
    const job = await s.get('job'), active = job && ['queued', 'running', 'paused'].includes(job.state);
    if (active && job.pipeline) return this.putPipeline({ ...out, state: job.kind === 'trim' ? 'updating' : 'building', build: this.progress(job), tree: prev.tree });
    // Someone else's build (a benchmark on dev) holds the object: say so, and start nothing.
    if (active) return this.putPipeline({ ...out, state: prev.state && !['building', 'updating'].includes(prev.state) ? prev.state : (ready.now ? 'available' : 'early'), waiting: 'another build is running', tree: prev.tree, thru: prev.thru });
    const summary = await this.pipelineSummary();
    // A tree counts only if every week before its window has actually been played: one that
    // starts later than the league has reached (a correction that unsettled a week, or a
    // simulated tree on dev) must never be rebuilt over weeks that have not happened.
    const realTree = summary && summary.source === 'build' && Number(summary.season) === season && st.lastSettled >= summary.windowStart - 1;
    if (!enabled) return this.putPipeline({ ...out, state: st.seasonOver ? 'season-over' : ready.now ? 'available' : 'early', tree: realTree });
    // A failed job is retried at most three times, an hour apart.
    if (job && job.state === 'failed' && !force) {
      const since = now - Date.parse(job.finishedAt || job.startedAt || 0);
      if ((prev.attempts || 0) >= 3 || since < 3600000) return this.putPipeline({ ...out, state: 'failed', error: job.error || 'unknown', tree: realTree });
    }
    const start = async (kind, windowStart) => {
      out.attempts = job && job.state === 'failed' ? (prev.attempts || 0) + 1 : 0;
      const weeks = Array.from({ length: st.mpc - windowStart + 1 }, (_, k) => windowStart + k);
      const projections = await this.projections(src, cfg, weeks, st.current);
      if (kind === 'build') {
        const input = buildRealInput({ ...src, projections, season }, windowStart), id = `season-${season}-w${windowStart - 1}${src.dev ? '-dev' : ''}`;
        const r = await this.startJob({ input, datasetId: id, prefix: `fortune-teller/library/${id}/`, activate: true, pipeline: true, meta: { id, label: `Season ${season}, from week ${windowStart}`, source: 'build', throughWeek: windowStart - 1 } });
        return this.putPipeline({ ...out, state: r.ok ? 'building' : 'failed', error: r.ok ? null : r.error, build: r.ok ? this.progress(r.job) : null });
      }
      const nt = newTrims(summary, src.sched);
      const ppg = new Map(summary.teams.map((t, i) => [t.id, summary.trims[summary.trims.length - 1].pf[i] / Math.max(1, summary.windowStart - 1)]));
      const byId = new Map(src.sched.schedule.map((m) => [m.id, m]));
      const games = summary.games.map((g) => (nt.future[g.i] && nt.future[g.i].digit != null ? g : { ...g, ...gameChances(byId.get(g.matchupId) || { home: { teamId: g.a }, away: { teamId: g.b } }, g.week, st.current, projections, ppg) }));
      const r = await this.startJob({ kind: 'trim', trims: nt.trims, future: nt.future, games, datasetId: summary.datasetId, pipeline: true });
      return this.putPipeline({ ...out, state: r.ok ? 'updating' : 'failed', error: r.ok ? null : r.error, build: r.ok ? this.progress(r.job) : null, tree: true });
    };
    if (!realTree || force) {
      if (st.seasonOver && !realTree) return this.putPipeline({ ...out, state: 'season-over', tree: false });
      if (!ready.now && !realTree) return this.putPipeline({ ...out, state: 'early', tree: false });
      return start('build', realTree && force ? summary.windowStart : st.lastSettled + 1);
    }
    // A change to anything the tree rests on rebuilds it, over the same weeks.
    if (treeFingerprint(src.sched, src.settingsRaw, src.teamsRaw, summary.windowStart, season) !== summary.fingerprint) return start('build', summary.windowStart);
    if (newTrims(summary, src.sched).trims.length) return start('trim');
    // Nothing to do: make sure the league is looking at this tree (unless dev has pinned another view).
    if (!(await this.pinned())) { const live = await this.activeSummary(); if (!live || live.datasetId !== summary.datasetId) await this.activateTree((await s.get('ptree')).prefix, summary); }
    return this.putPipeline({ ...out, state: st.seasonOver ? 'season-over' : 'ready', tree: true, thru: summary.trims[summary.activeTrim ?? summary.trims.length - 1].thru });
  }

  progress(job) {
    if (!job) return null;
    return { id: job.id, kind: job.kind || 'build', state: job.state, team: job.team, n: job.n, part: job.chunk, parts: 3 ** (job.k || 0), next: job.next,
      startedAt: job.startedAt, slices: (job.slices || []).length, paths: job.paths };
  }

  /** Starts a build or an update. Kept separate from the route so the pipeline can call it. */
  async startJob(body) {
    const s = this.s(), cur = await s.get('job');
    if (cur && ['queued', 'running', 'paused'].includes(cur.state)) return { ok: false, error: 'a build is already in progress', job: cur };
    let job;
    if (body.kind === 'trim') {
      const summary = await this.pipelineSummary(), tree = await s.get('ptree'); if (!summary || !tree) return { ok: false, error: 'nothing built to update' };
      await s.put('trimInput', { trims: body.trims, future: body.future, games: body.games });
      job = { kind: 'trim', state: 'queued', id: tree.id, prefix: tree.prefix, next: 'trim-team', team: 0, n: summary.teams.length, paths: summary.paths, pipeline: !!body.pipeline, startedAt: new Date(this.now()).toISOString(), slices: [] };
      for (let i = 0; i < job.n; i++) await s.delete('trimteam:' + i);
      await this.log('info', `update queued: ${body.trims.map((t) => 'week ' + t.thru).join(', ')}`);
    } else {
      const N = pathCount(body.input);
      if (N > PATH_CEILING) return { ok: false, error: `${N.toLocaleString('en-US')} paths is over the ceiling of ${PATH_CEILING.toLocaleString('en-US')}` };
      const cfg0 = await this.config();
      const plan = partPlan(body.input, { nsPerPath: { fast: cfg0.nsFast, h2h: cfg0.nsH2h, div: cfg0.nsDiv }, targetMs: cfg0.targetSliceMs });
      if (cfg0.partDigits >= 0) { plan.k = Math.min(cfg0.partDigits, body.input.games.length); plan.parts = 3 ** plan.k; }
      job = { kind: 'build', state: 'queued', id: body.datasetId, prefix: body.prefix, meta: body.meta || {}, activate: body.activate, pipeline: !!body.pipeline,
        next: 'prepare', team: 0, chunk: 0, k: plan.k, plan, n: body.input.teams.length, paths: N, startedAt: new Date(this.now()).toISOString(), slices: [] };
      await s.put('input', body.input);
      for (let i = 0; i < job.n; i++) await s.delete('team:' + i);
      await this.log('info', `build ${job.id} queued: ${N.toLocaleString('en-US')} paths, ${job.n} teams`);
    }
    await s.put('job', job); await this.env.DATA.put(FT_ACTIVE_KEY, job.id);
    await s.setAlarm(this.now() + 50);
    return { ok: true, job };
  }

  /** One team's update: its best path and simplest path for each newly settled week. */
  async trimTeam(job) {
    const s = this.s(), i = job.team, summary = await this.pipelineSummary(), ti = await s.get('trimInput');
    const G = summary.games.length, base = { ...summary, future: ti.future, played: summary.played || [] };
    const map = await (async () => { const o = await this.env.DATA.get(`${job.prefix}maps/${summary.teams[i].id}.bin`); if (!o) return null; const raw = await inflateBytes(new Uint8Array(await o.arrayBuffer()));
      const meta = summary.maps[i]; return { nodes: new Int32Array(raw.buffer, raw.byteOffset, raw.length / 4), root: meta.root, G, leafBase: meta.leafBase || 256, leaves: meta.leaves || null }; })();
    const out = [];
    for (const tr of ti.trims) {
      let c = 0; for (let j = 0; j < tr.fixed; j++) c = c * 3 + ti.future[j].digit;
      const part = buildTeamPart({ ...base, trims: [tr] }, i, tr.fixed, c, { scanOnly: true }), b = part.best[0];
      const digits = (() => { let x = b.x; const d = new Array(G); for (let j = G - 1; j >= 0; j--) { d[j] = x % 3; x = Math.floor(x / 3); } return d.join(''); })();
      let simplest = null;
      if (map) {
        const pins = new Int8Array(G).fill(-1); for (let j = 0; j < tr.fixed; j++) pins[j] = ti.future[j].digit;
        const ix = new Map(summary.teams.map((t, k) => [t.id, k])), own = (g) => ix.get(g.a) === i || ix.get(g.b) === i;
        const order = summary.games.map((g, j) => j).filter((j) => j >= tr.fixed).sort((x, y) => (own(summary.games[y]) - own(summary.games[x])) || x - y);
        const prefer = (j) => { const g = ti.games[j]; return ix.get(g.a) === i ? 1 : ix.get(g.b) === i ? 2 : ((g.pA ?? 0.5) >= (g.pB ?? 0.5) ? 1 : 2); };
        const r = simplestPath(map, pins, summary.places, { order, prefer, budgetMs: Infinity, maxWork: 25e6, now: () => 0 });
        simplest = r.set ? { k: r.k, set: r.set } : { k: r.k, set: null, timedOut: !!r.timedOut };
      }
      const to = part.trimOdds && part.trimOdds[0];
      out.push({ defaultPath: digits, best: { start: b.s, size: b.k, lead: b.lead >= 1e14 ? null : +b.lead.toFixed(2) }, simplest, odds: to && to[1] ? +(to[0] / to[1]).toFixed(6) : null });
    }
    await s.put('trimteam:' + i, out); this.rows += 1;
    return `${summary.teams[i].name}: updated through week ${ti.trims[ti.trims.length - 1].thru}`;
  }

  async trimFinalize(job) {
    const s = this.s(), summary = await this.pipelineSummary(), ti = await s.get('trimInput'), per = [];
    for (let i = 0; i < job.n; i++) per.push(await s.get('trimteam:' + i));
    ti.trims.forEach((tr, q) => summary.trims.push({ ...tr, defaultPath: per.map((p) => p[q].defaultPath), best: per.map((p) => p[q].best), simplest: per.map((p) => p[q].simplest), odds: per.map((p) => p[q].odds ?? null) }));
    summary.future = ti.future; summary.games = ti.games; summary.activeTrim = summary.trims.length - 1; summary.updatedAt = new Date(this.now()).toISOString();
    for (const tr of summary.trims) { const f = finalOdds(summary, tr); if (f) tr.odds = f; }   // the season over: exactly in or out
    await this.env.DATA.put(`${job.prefix}summary.json`, JSON.stringify(summary), { httpMetadata: { contentType: 'application/json' } });
    try { const mo = await this.env.DATA.get(`${job.prefix}meta.json`); if (mo) { const meta = await mo.json(); meta.trims = summary.trims.map((t) => t.thru); meta.updatedAt = summary.updatedAt; await this.env.DATA.put(`${job.prefix}meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } }); } } catch { /* the listing catches up next time */ }
    const pinned = await this.pinned();
    if (!pinned) await this.activateTree(job.prefix, summary);
    return `moved on to week ${summary.trims[summary.activeTrim].thru}${pinned ? ' (in the library; dev is showing another view)' : ''}`;
  }

  async fetch(request) {
    const u = new URL(request.url), s = this.s();
    const json = (b, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/dryrun') return json(await this.dryRun());
    if (u.pathname === '/backfill-odds') return json(await this.backfillOdds(u.searchParams.get('id')));
    if (u.pathname === '/ptree') return json({ ok: true, tree: (await s.get('ptree')) || null });
    if (u.pathname === '/pipeline') { const e = u.searchParams.get('enabled'); const p = await this.runPipeline(u.searchParams.get('reason') || 'check', u.searchParams.get('force') === '1', e === '1' ? true : e === '0' ? false : null); return json({ ok: true, pipeline: p }); }
    if (u.pathname === '/start') {
      const r = await this.startJob(await request.json());
      return json(r, r.ok ? 200 : (/in progress/.test(r.error || '') ? 409 : 400));
    }
    if (u.pathname === '/cancel') { const job = await s.get('job'); if (job) { job.state = 'cancelled'; await s.put('job', job); } await s.deleteAlarm(); await this.env.DATA.delete(FT_ACTIVE_KEY); await this.log('warn', 'build cancelled'); return json({ ok: true }); }
    if (u.pathname === '/resume') {
      // Also restarts a build left without a next slice (a slice that failed past its retries).
      const job = await s.get('job'), alarm = await s.getAlarm();
      if (job && (job.state === 'paused' || (['queued', 'running'].includes(job.state) && (!alarm || alarm < this.now() - 60000)))) { await s.setAlarm(this.now() + 50); await this.log('info', 'resumed by hand'); }
      return json({ ok: true });
    }
    if (u.pathname === '/config') {
      const cfg = await this.config(); const q = u.searchParams;
      for (const [k, v] of q) if (k in FT_DEFAULTS) cfg[k] = typeof FT_DEFAULTS[k] === 'boolean' ? (v === '1' || v === 'true') : Number(v);
      await s.put('config', cfg); await this.log('info', 'governor settings changed'); return json({ ok: true, config: cfg });
    }
    if (u.pathname === '/tick') {
      // The site's minute cron calls this while a build is active. If the next slice is overdue
      // (alarms not being delivered), it runs slices itself, for up to about 20 seconds.
      const job = await s.get('job'), alarm = await s.getAlarm(), force = u.searchParams.get('force') === '1';
      if (!job || !['queued', 'running'].includes(job.state)) { await this.env.DATA.delete(FT_ACTIVE_KEY); return json({ ok: true, ran: 0, idle: true }); }
      if (!force && alarm && alarm > this.now() - 60000) return json({ ok: true, ran: 0, onTime: true });
      // Slices start only in the first 15 s, so even a merge that starts late ends inside the 30 s CPU limit.
      const t0 = Date.now(); let ran = 0;
      while (Date.now() - t0 < 15000 && !this.busy) {
        await this.alarm(); ran++;
        const j = await s.get('job'); if (!j || !['queued', 'running'].includes(j.state)) break;
      }
      if (ran) await this.log('warn', `${force ? 'ran' : 'cron ran'} ${ran} ${force ? '' : 'overdue '}slice${ran === 1 ? '' : 's'} on request`);
      const after = await s.get('job');
      return json({ ok: true, ran, state: after && after.state, team: after && after.team, chunk: after && after.chunk, next: after && after.next });
    }
    if (u.pathname === '/slice') {
      // Runs one slice inside this request instead of waiting for the alarm, and reports any error it throws.
      try { await this.alarm(); return json({ ok: true, marks: this.marks || [] }); }
      catch (e) { return json({ ok: false, error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 1500), marks: this.marks || [] }); }
    }
    if (u.pathname === '/input') { return json({ ok: true, input: (await s.get('input')) || null, job: (await s.get('job')) || null }); }
    if (u.pathname === '/kick') {
      // Re-arms a build whose next slice never ran. Reports a refusal plainly (for example a spent daily write quota).
      const job = await s.get('job');
      if (!job || !['queued', 'running', 'paused'].includes(job.state)) return json({ ok: false, error: 'no build in progress' });
      try { await s.setAlarm(this.now() + 50); await this.env.DATA.put(FT_ACTIVE_KEY, job.id); await this.log('warn', 're-armed a stalled build'); return json({ ok: true }); }
      catch (e) { return json({ ok: false, error: String((e && e.message) || e) }); }
    }
    if (u.pathname === '/status') {
      const cfg = await this.config(), day = new Date(this.now()).toISOString().slice(0, 10);
      let [job, log, meter, alarm] = await Promise.all([s.get('job'), s.get('log'), this.meter(day), s.getAlarm()]);
      // Watchdog: a build whose next slice is over two minutes late is re-armed when anyone looks.
      let watchdog = null;
      if (job && ['queued', 'running'].includes(job.state) && alarm && alarm < this.now() - 120000) {
        try { await s.setAlarm(this.now() + 50); await this.log('warn', `watchdog: next slice was ${Math.round((this.now() - alarm) / 60000)} min overdue; re-armed`); watchdog = 're-armed'; alarm = this.now() + 50; }
        catch (e) { watchdog = 'refused: ' + String((e && e.message) || e); }
      }
      const gov = await this.governor(cfg);
      return json({ ok: true, job: job || null, config: cfg, meter, governor: gov, log: (log || []).slice(-80).reverse(), alarm: alarm ? new Date(alarm).toISOString() : null, now: new Date(this.now()).toISOString(), watchdog });
    }
    return json({ ok: false }, 404);
  }

  /** Where the last slice got to, kept in R2 so it survives whatever stops a slice. */
  async mark(step, extra = {}) {
    // Every step is kept in memory; only the start, the end of the heavy work and the end are
    // written out (a slice that dies mid-way shows which of those it reached), so markers cost
    // three R2 writes a slice rather than one per step.
    this.marks = (this.marks || []).concat({ step, at: new Date().toISOString(), ...extra }).slice(-40);
    if (!this.env.DEV_TOKEN) return;               // dev only: production writes no markers
    if (!['start', 'part built', 'end'].includes(step) && !extra.error) return;
    try { await this.env.DATA.put('fortune-teller/debug/last-slice.json', JSON.stringify(this.marks)); } catch { /* diagnostics must never stop a build */ }
  }

  async alarm() {
    if (this.busy) return;                      // a slice is already running in this instance
    this.busy = true;
    try { await this.slice(); } finally { this.busy = false; }
  }

  async slice() {
    this.marks = []; await this.mark('start');
    const s = this.s(), job = await s.get('job');
    await this.mark('job read', { state: job && job.state, next: job && job.next, team: job && job.team, chunk: job && job.chunk });
    if (!job || !['queued', 'running', 'paused'].includes(job.state)) return;
    const cfg = await this.config(); this.rows = 0;
    const gov = await this.governor(cfg);
    await this.mark('governor', { ok: gov.ok, reason: gov.reason || null });
    if (!gov.ok) {
      if (job.state !== 'paused' || job.pauseReason !== gov.reason) await this.log('warn', `paused: ${gov.reason}`);
      job.state = 'paused'; job.pauseReason = gov.reason; job.resumeAt = new Date(gov.until).toISOString();
      await s.put('job', job); await s.setAlarm(gov.until); return;
    }
    job.state = 'running'; job.pauseReason = null; job.resumeAt = null;
    const t0 = Date.now(); let step = job.next, detail = '';
    try {
      const input = await s.get('input');
      if (job.next === 'prepare') { job.next = 'team'; detail = `${job.paths.toLocaleString('en-US')} paths`; }
      else if (job.next === 'team' && job.k > 0) {
        // One part of this team per slice; after the last, merging starts at the parts' level.
        await this.mark('input read', { games: input && input.games.length });
        const i = job.team, c = job.chunk, part = buildTeamPart(input, i, job.k, c);
        await this.mark('part built', { nodes: part.nodes.length / 4 });
        const zz = await deflateRaw(new Uint8Array(part.nodes.buffer, part.nodes.byteOffset, part.nodes.byteLength));
        await this.mark('part compressed', { bytes: zz.length });
        await this.env.DATA.put(`${job.prefix}work/t${i}-L${job.k}-c${c}.bin`, zz);
        await this.mark('part stored');
        const partMeta = { root: part.root, LB: part.LB, leaves: part.leaves, fin: part.fin, best: part.best, trimOdds: part.trimOdds, paths: part.paths };
        await this.mark('meta ready', { json: JSON.stringify(partMeta).length, best: JSON.stringify(part.best).slice(0, 300) });
        await s.put(`part:${i}:${job.k}:${c}`, partMeta); this.rows += 1;
        await this.mark('meta saved');
        detail = `${input.teams[i].name}: part ${c + 1}/${3 ** job.k}, ${(part.nodes.length / 4).toLocaleString('en-US')} nodes`;
        job.chunk = c + 1; if (job.chunk >= 3 ** job.k) { job.next = 'merge'; job.mergeLevel = job.k; job.mergeGroup = 0; }
      } else if (job.next === 'merge') {
        // Staged: up to 27 parts per slice, folded in one at a time and let go.
        const i = job.team, L = job.mergeLevel, m = Math.min(3, L), g = job.mergeGroup, groups = 3 ** (L - m), nTrims = (input.trims || []).length;
        const key = (c) => `part:${i}:${L}:${g * 3 ** m + c}`, bin = (c) => `${job.prefix}work/t${i}-L${L}-c${g * 3 ** m + c}.bin`;
        const load = async (c, withNodes) => {
          const meta = await s.get(key(c)); if (!withNodes) return meta;
          const raw = await inflateRaw(new Uint8Array(await (await this.env.DATA.get(bin(c))).arrayBuffer()));
          return { ...meta, nodes: new Int32Array(raw.buffer, raw.byteOffset, raw.length / 4) };
        };
        const merged = await mergeParts(3 ** m, load, L, L - m, input.teams.length, nTrims);
        for (let c = 0; c < 3 ** m; c++) { await s.delete(key(c)); await this.env.DATA.delete(bin(c)); }
        if (L - m === 0) {
          const r = finishFromPart(input, i, merged), z = await deflateRaw(new Uint8Array(r.nodes.buffer, r.nodes.byteOffset, r.nodes.byteLength));
          await this.env.DATA.put(`${job.prefix}maps/${input.teams[i].id}.bin`, z, { httpMetadata: { contentType: 'application/octet-stream' } });
          await s.put('team:' + i, { root: r.root, nodeCount: r.nodeCount, trims: r.trims, odds: r.odds, bytes: z.length, ...(r.leaves ? { leafBase: r.leafBase, leaves: r.leaves } : {}) }); this.rows += 1;
          detail = `${input.teams[i].name}: merged, ${r.nodeCount.toLocaleString('en-US')} nodes, ${(z.length / 1024).toFixed(0)} KB, odds ${(100 * r.odds).toFixed(1)}%`;
          job.team++; job.chunk = 0; job.next = job.team >= job.n ? 'finalize' : 'team';
        } else {
          await this.env.DATA.put(`${job.prefix}work/t${i}-L${L - m}-c${g}.bin`, await deflateRaw(new Uint8Array(merged.nodes.buffer, merged.nodes.byteOffset, merged.nodes.byteLength)));
          await s.put(`part:${i}:${L - m}:${g}`, { root: merged.root, LB: merged.LB, leaves: merged.leaves, fin: merged.fin, best: merged.best, trimOdds: merged.trimOdds, paths: merged.paths }); this.rows += 1;
          detail = `${input.teams[i].name}: merge stage ${L}→${L - m}, group ${g + 1}/${groups}, ${(merged.nodes.length / 4).toLocaleString('en-US')} nodes`;
          job.mergeGroup = g + 1; if (job.mergeGroup >= groups) { job.mergeLevel = L - m; job.mergeGroup = 0; }
        }
      }
      else if (job.next === 'team') {
        const i = job.team, r = buildTeam(input, i);
        const z = await deflateRaw(new Uint8Array(r.nodes.buffer));
        await this.env.DATA.put(`${job.prefix}maps/${input.teams[i].id}.bin`, z, { httpMetadata: { contentType: 'application/octet-stream' } });
        await s.put('team:' + i, { root: r.root, nodeCount: r.nodeCount, trims: r.trims, odds: r.odds, bytes: z.length, ...(r.leaves ? { leafBase: r.leafBase, leaves: r.leaves } : {}) }); this.rows += 1;
        detail = `${input.teams[i].name}: ${r.nodeCount.toLocaleString('en-US')} nodes, ${(z.length / 1024).toFixed(0)} KB, odds ${(100 * r.odds).toFixed(1)}%`;
        job.team++; if (job.team >= job.n) job.next = 'finalize';
      } else if (job.next === 'trim-team') {
        detail = await this.trimTeam(job);
        job.team++; if (job.team >= job.n) job.next = 'trim-finalize';
      } else if (job.next === 'trim-finalize') {
        detail = await this.trimFinalize(job);
        job.next = 'done'; job.state = 'done'; job.finishedAt = new Date(this.now()).toISOString();
      } else if (job.next === 'finalize') {
        const results = []; for (let i = 0; i < job.n; i++) results.push(await s.get('team:' + i));
        const summary = assembleSummary(input, results, { builtAt: new Date(this.now()).toISOString(), source: job.meta.source || 'build', datasetId: job.id });
        await this.env.DATA.put(`${job.prefix}summary.json`, JSON.stringify({ ...summary, activeTrim: 0 }), { httpMetadata: { contentType: 'application/json' } });
        if (job.pipeline) await s.put('ptree', { id: job.id, prefix: job.prefix });
        const meta = { ...job.meta, id: job.id, paths: job.paths, teams: job.n, builtAt: summary.builtAt, trims: summary.trims.map((t) => t.thru),
          odds: Object.fromEntries(input.teams.map((t, i) => [t.id, results[i].odds])), bytes: results.reduce((a, r) => a + r.bytes, 0) };
        await this.env.DATA.put(`${job.prefix}meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
        if (job.activate && cfg.activateOnFinish && !(job.pipeline && await this.pinned())) {
          for (const t of input.teams) { const o = await this.env.DATA.get(`${job.prefix}maps/${t.id}.bin`); await this.env.DATA.put(ftMapKey(t.id), await o.arrayBuffer()); }
          await this.env.DATA.put(FT_SUMMARY_KEY, JSON.stringify({ ...summary, activeTrim: 0 }), { httpMetadata: { contentType: 'application/json' } });
          detail = 'written and made active';
        } else detail = 'written to the library';
        job.next = 'done'; job.state = 'done'; job.finishedAt = new Date(this.now()).toISOString();
      }
    } catch (e) {
      job.state = 'failed'; job.error = String((e && e.message) || e);
      await this.log('error', `${step} failed: ${job.error}`);
    }
    await this.mark('step done', { state: job.state, error: job.error || null });
    await s.put('job', job); this.rows += 1;
    await this.mark('job saved');
    const wall = Date.now() - t0;                       // the clock moves across I/O, so this includes the slice's CPU
    job.slices = (job.slices || []).concat({ step, team: step === 'team' || step === 'merge' ? (job.k > 0 && step === 'team' ? job.team : job.team - 1) : null, part: step === 'team' && job.k > 0 ? job.chunk - 1 : null, ms: wall, at: new Date(this.now()).toISOString() }).slice(-400);
    await s.put('job', job);
    const day = new Date(this.now()).toISOString().slice(0, 10), m = await this.meter(day);
    m.alarms += 1; m.wallMs += wall; m.rows += this.rows + 3; await s.put('meter:' + day, m);
    if (job.state !== 'failed') await this.log('info', `${step}${detail ? ' · ' + detail : ''} · ${wall} ms`);
    if (!['done', 'failed', 'cancelled'].includes(job.state)) await s.setAlarm(this.now() + Math.max(0, cfg.sliceGapMs));
    else if (job.state === 'done') await this.log('info', `build ${job.id} finished`);
    if (['done', 'failed', 'cancelled'].includes(job.state)) await this.env.DATA.delete(FT_ACTIVE_KEY);
    // A build or update the pipeline started reports its progress, and when it ends the
    // pipeline runs again, so whatever comes next (say, an update for a week that settled
    // during the build) starts straight away.
    if (job.pipeline) {
      try {
        if (['done', 'failed', 'cancelled'].includes(job.state)) await this.runPipeline(`after ${job.kind || 'build'}`);
        else { const o = await this.env.DATA.get(FT_PIPELINE_KEY); const pl = o ? await o.json() : {}; await this.putPipeline({ ...pl, state: job.kind === 'trim' ? 'updating' : 'building', build: this.progress(job) }); }
      } catch (e) { await this.log('warn', `pipeline follow-up failed: ${String((e && e.message) || e)}`); }
    }
    await this.mark('end');
  }
}
