/**
 * Fortune Teller's stores and routes.
 *
 * The season's build writes two things to R2 and this module only ever reads
 * them: a small summary (odds, games, trims, default paths) and one compressed
 * map per team. Standings are never stored: the page recomputes any path's
 * table from its digits. Logos come from the standings digest at read time,
 * so they always follow the league's current uploads.
 */
import { getPart } from './store.js';
import { finalOdds } from '../app/fortune-teller/final.js';
import { leagueState } from './ftleague.js';
import { json } from './http.js';

export const FT_SUMMARY_KEY = 'fortune-teller/summary.json';
export const ftMapKey = (teamId) => `fortune-teller/maps/${String(teamId).replace(/[^0-9A-Za-z_-]/g, '')}.bin`;

async function teamLogos(env) {
  const out = new Map();
  try {
    const obj = await getPart(env, 'standings_digest', 'main');
    if (!obj) return out;
    const d = await obj.json();
    for (const r of (d && d.rows) || []) {
      const id = r.teamId ?? r.id;
      if (id != null && r.logo) out.set(Number(id), r.logo);
    }
  } catch { /* shields instead */ }
  return out;
}

/** The page's whole payload, or { ready:false } before anything has been built. */
export const FT_PIPELINE_STATUS_KEY = 'fortune-teller/pipeline.json';
/* Dev only: which view the dev site shows (see the portal's view switch). Read only where
   the dev token exists, so production never looks at it. */
export const FT_DEV_VIEW_KEY = 'fortune-teller/dev-view.json';
async function devView(env) { if (!env.DEV_TOKEN) return null; try { const o = await env.DATA.get(FT_DEV_VIEW_KEY); return o ? await o.json() : null; } catch { return null; } }

/** Where the pipeline stands (early, available, building, updating, ready, season-over, failed). */
async function pipelineStatus(env) { try { const o = await env.DATA.get(FT_PIPELINE_STATUS_KEY); return o ? await o.json() : null; } catch { return null; } }

export async function fortuneTellerPayload(env) {
  let obj = null;
  try { obj = await env.DATA.get(FT_SUMMARY_KEY); } catch { obj = null; }
  let pipeline = await pipelineStatus(env);
  const view = await devView(env);
  if (view && view.pipeline) pipeline = view.pipeline;
  const espnHistory = await espnOddsHistory(env);
  // Before a map exists the page still shows everything general, from ESPN's figures and the standings.
  const notReady = async () => { let preview = await previewData(env);
    // Dev only: the view switch can show a finished season on a league that is still playing.
    if (view && view.finalPreview && preview) preview = { ...preview, seasonOver: true, teams: preview.teams.map((t) => ({ ...t, playoffPct: t.rank <= preview.places ? 1 : 0 })) }; return { ok: true, ready: false, pipeline, espnHistory, preview, leagueName: (preview && preview.leagueName) || (view && view.leagueName) || null }; };
  if (view && view.notReady) return notReady();
  if (!obj) return notReady();
  let s;
  try { s = await obj.json(); } catch { return notReady(); }
  const logos = await teamLogos(env);
  s.teams = (s.teams || []).map((t) => ({ ...t, logo: logos.get(Number(t.id)) || null }));
  return { ok: true, ready: true, ...s, pipeline, espnHistory };
}

/** One team's map, compressed exactly as stored: the browser inflates it. */
export async function fortuneTellerMap(env, rawId) {
  const id = decodeURIComponent(rawId || '').trim();
  if (!/^[0-9]{1,6}$/.test(id)) return json({ ok: false, error: 'bad team' }, 400);
  let obj = null;
  try { obj = await env.DATA.get(ftMapKey(id)); } catch { obj = null; }
  if (!obj) return json({ ok: false, error: 'no map' }, 404);
  return new Response(await obj.arrayBuffer(), {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' },
  });
}

/* ── Sim %: every team's simulated odds, for the dashboard and the LLM export ── */
export const FT_ESPN_ODDS_KEY = 'fortune-teller/espn-odds.json';
const SIM_MEMO = new WeakMap();   // per storage binding: the figures change weekly, the dashboard polls every 15 s

/**
 * Every team's simulated playoff odds after the latest settled week, or the reason there are
 * none yet (early, available, building, failed, no-data). Reads the summary and the pipeline
 * record only, never a map; on dev it follows the view switch like the tool itself.
 */
export async function simOdds(env, { fresh = false } = {}) {
  const hit = SIM_MEMO.get(env.DATA);
  if (!fresh && hit && Date.now() - hit.at < 30000) return hit.value;
  let pipeline = await pipelineStatus(env); const view = await devView(env);
  if (view && view.pipeline) pipeline = view.pipeline;
  let summary = null;
  if (!(view && view.notReady)) { try { const o = await env.DATA.get(FT_SUMMARY_KEY); summary = o ? await o.json() : null; } catch { summary = null; } }
  const st = pipeline && pipeline.state;
  let value = { state: st === 'updating' ? 'building' : (st || null), opensAfterWeek: pipeline && pipeline.opensAfterWeek != null ? pipeline.opensAfterWeek : null, byTeam: null };
  if (summary && Array.isArray(summary.trims) && summary.trims.length) {
    const k = Math.max(0, Math.min(summary.trims.length - 1, summary.activeTrim ?? summary.trims.length - 1)), tr = summary.trims[k];
    // Once every game is played the odds are exactly 1 or 0, however the map shares out level teams.
    const odds = finalOdds(summary, tr) || tr.odds;
    const byTeam = {}; if (Array.isArray(odds)) summary.teams.forEach((t, i) => { if (typeof odds[i] === 'number') byTeam[t.id] = odds[i]; });
    if (Object.keys(byTeam).length) value = { state: st === 'updating' || (st === 'building' && summary.source === 'build') ? 'updating' : 'ready', thru: tr.thru, byTeam };
  }
  value.final = await espnFinal(env);
  SIM_MEMO.set(env.DATA, { at: Date.now(), value });
  return value;
}

/**
 * Once the real regular season is over, ESPN's playoff odds are settled too: every team has a
 * place or it does not. Returns the league's playoff places and each team's final seed then, or
 * null while games remain. Surfaces show Clinched or Eliminated in place of ESPN's figure.
 */
export async function espnFinal(env) {
  const read = async (k) => { try { const o = await getPart(env, k, 'main'); return o ? await o.json() : null; } catch { return null; } };
  const [sched, settings, st] = await Promise.all([read('season_schedule'), read('league_settings'), read('standings_digest')]);
  if (!sched || !settings || !st || !Array.isArray(st.rows)) return null;
  const ls = leagueState(sched, settings); if (!ls.seasonOver) return null;
  const places = Number(((settings.settings || {}).scheduleSettings || {}).playoffTeamCount) || 4, inByTeam = {};
  for (const r of st.rows) if (r.rank) inByTeam[r.teamId] = r.rank <= places;
  return { seasonOver: true, places, inByTeam };
}

/** ESPN's playoff odds as recorded after each settled week this season (week 0 is before any). */
export async function espnOddsHistory(env) { try { const o = await env.DATA.get(FT_ESPN_ODDS_KEY); return o ? await o.json() : null; } catch { return null; } }

/**
 * What the page shows before a map exists: every team as the standings have it, with ESPN's
 * playoff odds, and the league's playoff places. The route brings both datasets up to date
 * through ensureDataset before this reads them.
 */
export async function previewData(env) {
  const read = async (k) => { try { const o = await getPart(env, k, 'main'); return o ? await o.json() : null; } catch { return null; } };
  const [st, settings, sched] = await Promise.all([read('standings_digest'), read('league_settings'), read('season_schedule')]);
  const rows = (st && Array.isArray(st.rows)) ? st.rows : [];
  if (!rows.length || (st && st.identified === false)) return null;
  const sch = (settings && settings.settings && settings.settings.scheduleSettings) || {};
  const oddsSum = rows.reduce((a, r) => a + (typeof r.playoffPct === 'number' ? r.playoffPct : 0), 0);
  const places = Number(sch.playoffTeamCount) || (oddsSum > 0 ? Math.round(oddsSum) : 4);
  const ls = sched && settings ? leagueState(sched, settings) : null, seasonOver = !!(ls && ls.seasonOver);
  return {
    leagueName: (settings && settings.settings && settings.settings.name) || null,
    places, seasonOver, weeksPlayed: rows.reduce((a, r) => Math.max(a, (r.wins || 0) + (r.losses || 0) + (r.ties || 0)), 0),
    consolation: !sch.consolationLadderDisabled, started: Boolean(st && st.started),
    teams: rows.slice().sort((a, b) => (a.rank || 99) - (b.rank || 99)).map((r) => ({
      id: r.teamId, name: r.name, logo: r.logo || null, rank: r.rank, w: r.wins || 0, l: r.losses || 0, t: r.ties || 0,
      pf: r.pointsFor || 0, pa: r.pointsAgainst || 0,
      // After the regular season a team is in or out: ESPN's figure is replaced by its final seed.
      playoffPct: seasonOver && r.rank ? (r.rank <= places ? 1 : 0) : typeof r.playoffPct === 'number' ? r.playoffPct : null })),
  };
}
