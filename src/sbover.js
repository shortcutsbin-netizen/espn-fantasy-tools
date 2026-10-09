/**
 * Site Backend: the Overview tab's panels, and the reckonings several tabs share
 * (usage against the free limits, page states, the verdict).
 */

import { apiReasons } from './sbapi.js';
import { DATASETS } from './datasets.js';
import { TOOLS, visibilityOf, VISIBILITY, describeTileOrder } from './tools.js';
import { RELEASE_NOTE_ITEMS } from './release.js';
import { TRADE_ROWS } from './traderows.js';
import { describeConfig } from './config.js';
import { timelineSize } from './timeline.js';
import { BYTE_BUDGET } from './scoretimeline.js';
import { LOG_BUDGET_REF } from './sblimits.js';
import {
  C, B, worst, hourOf, utcMidnight, median, ttlText, datasetRows, paramRows, upstream,
  eventsSince, countEvents, groupEvents, latestEvents, sumReq, servedReq, ticksOf, pageVisibility, visibilityLabel, PAGES, pageOf,
} from './sbcore.js';
import { pageForRoute } from './readers.js';
import { levelFrom, paceOf, BRAKE_OF, BRAKE_WORDS, LIMIT_WORDS } from './budget.js';

export const LIMITS = {
  worker: 100000, doReq: 100000, rowsW: 100000, rowsR: 5000000, kvR: 100000, kvW: 1000,
  r2Bytes: 10 * 1024 ** 3, r2A: 1000000, r2B: 10000000, logs: 200000,
};

const sumOps = (rows, pred) => {
  let n = 0;
  for (const { d } of rows) {
    for (const [k, v] of Object.entries(d.ops || {})) if (pred(k)) n += v;
    for (const [k, v] of Object.entries(d.dsOps || {})) if (pred(k)) n += v;
  }
  return n;
};

/**
 * One UTC day's use of each free limit, as the site counts it: today by default,
 * or a finished day when the hourly report closes it for the usage history.
 */
export function usage(src, dayStart = null) {
  const today = utcMidnight(src.now);
  const mid = dayStart == null ? today : dayStart;
  const key = `usage:${mid}`;
  if (!src.memo) src.memo = new Map();
  if (!src.memo.has(key)) src.memo.set(key, usageOf(src, mid, mid === today));
  return src.memo.get(key);
}

async function usageOf(src, mid, isToday) {
  const rows = (await src.hours(48)).filter((r) => r.hour >= mid && r.hour < mid + 86400000);
  const req = servedReq(rows);
  const ticks = Object.keys(ticksOf(rows)).length;
  const day = new Date(mid).toISOString().slice(0, 10);
  const logM = isToday ? src.meter() : ((src.deps.meta('daily', []) || []).find((x) => x.day === day) || { req: 0, rows: 0, read: 0 });
  const peek = await src.ftPeek();
  const ftm = peek && peek.meter && peek.meter.day === day ? peek.meter : { alarms: 0, rows: 0, wallMs: 0 };
  let dsReq = 0;
  for (const { d } of rows) for (const t of Object.values(d.ds || {})) dsReq += t.req || 0;
  let signIns = 0;
  try { signIns = countEvents(src, mid, "AND kind = 'sign-in'").n; } catch (err) { if (!(err && err.logPaused)) throw err; /* resting: left out of the estimate */ }
  let tlRows = 0;
  for (const t of Object.values(ticksOf(rows))) if (t && t.timeline && t.timeline.recorded) tlRows += 3;
  const doReq = sumOps(rows, (k) => k.startsWith('do:') && k !== 'do:SITE_LOG') + logM.req + (ftm.alarms || 0);
  const u = {
    worker: req + ticks,
    doReq,
    ftDo: ftm.alarms || 0,
    logDo: logM.req,
    rowsW: logM.rows + (ftm.rows || 0) + dsReq + tlRows + signIns,
    logRows: logM.rows,
    rowsR: logM.read,
    kvR: sumOps(rows, (k) => k === 'kvr'),
    kvW: sumOps(rows, (k) => k === 'kvw'),
    r2A: sumOps(rows, (k) => k === 'r2a'),
    r2B: sumOps(rows, (k) => k === 'r2b'),
    cacheHit: sumOps(rows, (k) => k === 'cacheHit'),
    cacheMiss: sumOps(rows, (k) => k === 'cacheMiss'),
  };
  u.logs = u.worker + u.doReq;
  if (!isToday) return { day, ...u };
  const census = await src.census();
  u.r2Bytes = census ? census.total.bytes : null;
  const days = src.deps.meta('days', []) || [];
  const month = new Date(mid).toISOString().slice(0, 7);
  u.r2AMonth = u.r2A + days.filter((x) => x.day.startsWith(month)).reduce((a, x) => a + (x.r2A || 0), 0);
  u.r2BMonth = u.r2B + days.filter((x) => x.day.startsWith(month)).reduce((a, x) => a + (x.r2B || 0), 0);
  u.week = days.slice(-6);
  u.resetsAt = mid + 86400000;
  return u;
}

/** The worst state of everything a page depends on. */
export function pageState(page, ctx) {
  const s = [];
  for (const k of upstream(page.datasets).keys()) {
    const r = ctx.rowByKey[k];
    if (r && r.sev !== 'idle') s.push(r.sev);
  }
  if ((page.key === 'home' || page.key === 'live-matchups') && ctx.logosFailing.length) s.push('warn');
  if (page.key === 'fortune-teller' && ctx.ftp) {
    if (ctx.ftp.state === 'failed') s.push('bad');
    else if (['building', 'updating'].includes(ctx.ftp.state)) s.push('run');
  }
  if (page.key === 'live-matchups' && ctx.window.open) s.push('run');
  if (page.key === 'config' && ctx.espn.failing) s.push('warn');
  if (page.key === 'site-api' && ctx.apiHot) s.push(ctx.apiHot);
  return s.length ? worst(s) : 'ok';
}

/** The cron's line in Needs attention, if it has one. */
export function cronReason(ctx, now) {
  if (ctx.lastTick == null) return ctx.finished ? { s: 'warn', text: 'No cron tick recorded yet', go: 'p-cron' } : null;
  if (now - ctx.lastTick > 5 * 60000) return { s: 'bad', text: `No cron tick for ${Math.round((now - ctx.lastTick) / 60000)} minutes`, go: 'p-cron' };
  if (ctx.cronMissed >= CRON_MISS_WARN) {
    return { s: 'warn', text: `Cron missed ${ctx.cronMissed} ticks ${ctx.cronCounted < 60 ? 'since the log started' : 'in the last hour'} (${ctx.cronCounted - ctx.cronMissed} of ${ctx.cronCounted})`, go: 'p-cron' };
  }
  return null;
}

/** Everything amber or red, one line each, with where it is explained. */
export async function reasons(src, ctx) {
  const r = [];
  const { cfg, espn } = ctx;
  if (!ctx.finished) r.push({ s: 'bad', text: 'Setup has not finished', go: 'p-config' });
  if (espn.failing) {
    const n = DATASETS.filter((d) => d.auth).length;
    r.push({ s: 'bad', text: `ESPN is refusing the league's cookies${espn.status ? ` (${espn.status})` : ''}: ${n} signed-in datasets are serving stored copies`, go: 'p-espn', since: espn.since });
  }
  for (const row of ctx.rows) {
    if (row.sev === 'bad') r.push({ s: 'bad', text: row.state === 'failing' ? `${row.key} has no stored copy and its last refresh failed` : `${row.key} is serving a copy over ten refresh intervals old after a failed refresh`, go: 'p-ds' });
  }
  const kept = ctx.rows.filter((x) => x.sev === 'warn' && x.state !== 'missing');
  if (kept.length) r.push({ s: 'warn', text: kept.length === 1 ? `${kept[0].key}: last refresh failed, so the stored copy is being served` : `${kept.length} datasets' last refresh failed, so stored copies are being served (${kept.slice(0, 3).map((x) => x.key).join(', ')}${kept.length > 3 ? ', …' : ''})`, go: 'p-ds' });
  const missing = ctx.rows.filter((x) => x.state === 'missing' && x.tier !== 'probe');
  if (missing.length && ctx.finished) r.push({ s: 'warn', text: `A re-pull is needed: ${missing.length} dataset${missing.length === 1 ? ' has' : 's have'} never been fetched on this deployment`, go: 'p-updates' });
  const cron = cronReason(ctx, src.now);
  if (cron) r.push(cron);
  if (ctx.ftp && ctx.ftp.state === 'failed') r.push({ s: 'bad', text: `Fortune Teller's pipeline failed${ctx.ftp.error ? `: ${String(ctx.ftp.error).slice(0, 80)}` : ''}`, go: 'p-ft' });
  if (ctx.errorsHour > 10) r.push({ s: 'bad', text: `${ctx.errorsHour} server errors in the last hour`, go: 'p-traffic' });
  for (const l of ctx.logosFailing) r.push({ s: 'warn', text: `Logo for ${l.name} failing to fetch; the stored copy is still served`, go: 'p-logos' });
  if (ctx.timelinePct > 0.8) r.push({ s: 'warn', text: `This week's score timeline is at ${Math.round(ctx.timelinePct * 100)}% of its byte budget`, go: 'p-livescore' });
  const u = await usage(src);
  const over = [['Worker requests', u.worker / LIMITS.worker], ['Durable Object requests', u.doReq / LIMITS.doReq], ['rows written', u.rowsW / LIMITS.rowsW], ['KV writes', u.kvW / LIMITS.kvW], ['KV reads', u.kvR / LIMITS.kvR]].filter((x) => x[1] > 0.7);
  for (const [n, p] of over) r.push({ s: 'warn', text: `${n} at ${Math.round(p * 100)}% of today's free limit`, go: 'p-usage' });
  // The brake (C5): which level, and which limit put it there.
  const lvl = levelFrom({ counts: { worker: u.worker, doReq: u.doReq, rowsW: u.rowsW, kvR: u.kvR, kvW: u.kvW }, rate: {} });
  const brake = BRAKE_OF[lvl.key] || 'normal';
  if (brake !== 'normal') r.push({ s: brake === 'economy' ? 'warn' : 'bad', text: `The brake is at ${BRAKE_WORDS[brake]}: ${LIMIT_WORDS[lvl.limit] || 'a limit'} at ${Math.round(lvl.frac * 100)}% of today's free limit, so pages slow down until the day's use falls back or 00:00 UTC`, go: 'p-usage' });
  // The backend clock (C5): a clock silent this hour, or the cron doing the work because the clock could not be reached.
  const cs = clockSummary(ctx.ticks, src.now - 3600000);
  // Judged on whether each clock was heard, not on which did the work: the one that arrives second does none.
  if (cs.clockOn && cs.heard.judged >= 30) {
    if (!cs.heard.alarm) r.push({ s: 'warn', text: 'The backend clock\'s own alarm has not fired this hour: the cron\'s knock is keeping every minute', go: 'p-cron' });
    else if (!cs.heard.knock && !cs.fallback) r.push({ s: 'warn', text: 'The cron has not knocked this hour: the backend clock\'s alarm is keeping every minute', go: 'p-cron' });
  }
  if (cs.fallback) r.push({ s: 'warn', text: `The cron did ${cs.fallback} minute${cs.fallback === 1 ? '' : 's'} of work itself this hour: the backend clock could not be reached`, go: 'p-cron' });
  const m = src.meter();
  if (m.paused) r.push({ s: 'warn', text: 'The log reached its daily budget: counters and status reports pause until 00:00 UTC', go: 'p-usage' });
  // Site API: a source in High activity (its likely member locked), an old key on its grace's last day, a failing snapshot.
  for (const x of await apiReasons(src)) r.push(x);
  return r;
}

export function verdictOf(rs) {
  const s = rs.length ? worst(rs.map((x) => x.s)) : 'ok';
  return { s, word: s === 'bad' ? 'Failing' : s === 'warn' ? 'Needs attention' : 'All good', reasons: rs };
}

/** The game window from the stored scoreboard: open now, or when the next opens. */
export function gameWindow(board, now) {
  const games = (board && board.games) || [];
  let open = false, closes = null, next = null, live = 0, fin = 0, up = 0;
  for (const g of games) {
    const k = Date.parse(g.kickoff || '');
    if (g.final) fin += 1; else if (g.inProgress || g.state === 'in') live += 1; else up += 1;
    if (!Number.isFinite(k)) continue;
    if (!g.final && now >= k - 2 * 60000 && now <= k + 4.5 * 3600000) { open = true; closes = Math.max(closes || 0, k + 4.5 * 3600000); }
    if (k > now && (next == null || k < next)) next = k;
  }
  return { open, closes, next, live, final: fin, upcoming: up, week: board && board.week, generatedAt: board && board.generatedAt };
}

// ---------------------------------------------------------------- the status strip

export async function strip(src, ctx) {
  const now = src.now, minute = Math.floor(now / 60000) * 60000;
  const beat = [];
  for (let i = 59; i >= 0; i--) {
    const m = minute - i * 60000;
    const st = tickState(ctx, m, now);
    beat.push(st === 'ok' ? 1 : st === 'miss' ? 0 : null);
  }
  const ver = src.deps.meta('version', null);
  const vm = src.facts.versionMetadata || null;
  const u = await usage(src);
  const lsd = await src.digest('live_scoring_digest');
  const set = await src.settings();
  return {
    beat, lastTick: ctx.lastTick,
    kv: [
      ['Build', C.txt(src.facts.build || '—', src.facts.version ? `version ${src.facts.version}` : null)],
      ['Deployed', vm && vm.timestamp ? C.time(vm.timestamp) : ver ? C.time(ver.since, 'first answered') : '—'],
      ['Season', C.txt(String((ctx.cfg && ctx.cfg.season) || '—'), set ? `week ${(lsd && lsd.matchupPeriod) || set.status.currentMatchupPeriod || '?'} of ${set.s.scheduleSettings ? set.s.scheduleSettings.matchupPeriodCount : '?'}` : null)],
      ['ESPN credentials', ctx.espn.failing ? C.pill('bad', 'refused', null) : C.pill('ok', 'accepted')],
      ['Fortune Teller', ctx.ftp ? C.pill(ftSev(ctx.ftp.state), ctx.ftp.state, ctx.ftp.state === 'early' && ctx.ftp.opensAfterWeek ? `opens after week ${ctx.ftp.opensAfterWeek}` : null) : C.txt('not run yet')],
      ['Server errors, 24 h', C.n(ctx.errors24)],
      ['Log budget today', C.pct(Math.max(src.meter().rows / LOG_BUDGET_REF.rows, src.meter().req / LOG_BUDGET_REF.requests, (src.meter().read || 0) / LOG_BUDGET_REF.read), 'of the log\'s daily budget')],
      ['Game window', ctx.window.open ? C.pill('run', 'open', ctx.window.closes ? null : null) : C.txt('closed', ctx.window.next ? null : 'no kickoff scheduled')],
      ['Next kickoff', ctx.window.next ? C.time(ctx.window.next) : '—'],
      ['Worker requests today', C.n(u.worker, 'estimate')],
    ],
  };
}

/**
 * One minute of the schedule: ticked, missed, before the log began, or still due. Cloudflare can
 * deliver a scheduled run tens of seconds late, so the current minute is never a miss, and the one
 * before it only once 45 seconds of grace have passed.
 */
export const TICK_GRACE_MS = 45000;
/* Cloudflare's scheduler can skip a minute now and then; one missed tick in an hour is drawn
   on the heartbeat but not raised. Two or more is a pattern worth a look. */
export const CRON_MISS_WARN = 2;
export function tickState(ctx, m, now) {
  if (ctx.ticks[m]) return 'ok';
  if (ctx.firstTick && m < ctx.firstTick) return 'none';
  const minute = Math.floor(now / 60000) * 60000;
  if (m >= minute || (m === minute - 60000 && now - minute < TICK_GRACE_MS)) return 'pending';
  return 'miss';
}

export const ftSev = (state) => (state === 'failed' ? 'bad' : ['building', 'updating'].includes(state) ? 'run' : state === 'ready' || state === 'season-over' ? 'ok' : 'idle');

// ---------------------------------------------------------------- panels

const P = (id, title, def) => ({ id, title, ...def });

async function visitsByPage(src, since) {
  const out = {};
  for (const [page, g] of groupEvents(src, since, "AND kind = 'visit'", 'page')) out[page] = { n: g.n, t: g.teams };
  return out;
}

export function feedRows(rows, reports) {
  const items = rows.map((e) => ({ id: e.id, at: e.at, kind: e.kind, sev: e.sev, text: e.text, page: e.page, team: e.team, n: e.n }));
  const byHour = new Map();
  for (const r of reports || []) {
    if (!byHour.has(r.hour)) byHour.set(r.hour, []);
    byHour.get(r.hour).push({ sub: r.sub, sev: r.sev, text: r.text });
  }
  for (const [hour, list] of byHour) items.push({ id: `r${hour}`, at: hour + 3600000, kind: 'status', sev: worst(list.map((x) => (x.sev === 'ok' ? 'ok' : x.sev))), report: list, hour });
  items.sort((a, b) => b.at - a.at);
  return items;
}

/* The brake's lines on every daily limit the site watches (C5): Economy at 60%, Protect at 80%. */
const BRAKE_LINES = [[0.6, 'Economy: pages slow down'], [0.8, 'Protect: the frontend calls no object; the rest is the backend\'s reserve']];

/** The brake and the suggested pace now, from the same counts as the gauges, with the limit nearest its line. */
function brakeFacts(u) {
  const counts = { worker: u.worker, doReq: u.doReq, rowsW: u.rowsW, kvR: u.kvR, kvW: u.kvW };
  const lvl = levelFrom({ counts, rate: {} });
  const brake = BRAKE_OF[lvl.key] || 'normal';
  const pace = paceOf(lvl.key, false);
  const near = lvl.limit ? `${LIMIT_WORDS[lvl.limit]} at ${(lvl.frac * 100).toFixed(1)}%` : 'nothing near a line';
  return B.kv([
    ['The brake now', C.pill(brake === 'normal' ? 'ok' : brake === 'economy' ? 'warn' : 'bad', BRAKE_WORDS[brake], near)],
    ['Suggested pace for the API', C.txt(pace.secs == null ? 'not until 00:00 UTC' : pace.secs === 60 ? 'once a minute' : pace.secs < 60 ? `every ${pace.secs} seconds` : `once every ${pace.secs / 60} minutes`)],
    ['What the brake does', C.txt(brake === 'normal' ? 'Nothing: every page runs as usual.' : brake === 'economy' ? 'Pages ask every minute while games are on and every 5 minutes otherwise; a page view refreshes only live scoring; settings are held 5 minutes.' : 'Pages ask every 5 minutes; no page view refreshes anything; the frontend calls no object but sign-in (capped) and the log’s report; Site Backend rests; settings are held 30 minutes.')],
  ]);
}

function gauge(label, used, limit, opts = {}) {
  return { label, used: used == null ? null : Math.round(used), limit, ...opts };
}

export const OVERVIEW = [
  P('p-attn', 'Needs attention', {
    live: true,
    sum: async (src, ctx) => (ctx.reasons.length ? [ctx.verdict.s, `${ctx.reasons.length} ${ctx.reasons.length === 1 ? 'item' : 'items'}`] : ['ok', 'nothing needs attention']),
    body: async (src, ctx) => (ctx.reasons.length
      ? [{ t: 'attn', items: ctx.reasons.map((x) => ({ s: x.s, text: x.text, go: x.go, since: x.since || null, ...(x.tab ? { tab: x.tab } : {}), ...(x.lock ? { lock: x.lock } : {}) })) }]
      : [B.empty('Nothing needs attention. Every dataset\'s last refresh worked, the cron has ticked every minute this hour, and ESPN is accepting the league\'s cookies.')]),
  }),
  P('p-since', 'Since you last opened', {
    sub: 'What happened since this browser last opened Site Backend', live: true,
    sum: async (src) => {
      const since = Number(src.params.seen) || src.now - 86400000;
      const ev = countEvents(src, since);
      const warn = countEvents(src, since, "AND sev IN ('warn','bad')").n;
      const changes = countEvents(src, since, "AND kind = 'change'").n;
      return ev.n ? [warn ? 'warn' : null, `${changes} change${changes === 1 ? '' : 's'}, ${countEvents(src, since, "AND kind = 'visit'").n} visits`] : ['ok', 'nothing new'];
    },
    body: async (src) => {
      const first = !Number(src.params.seen);
      const since = Number(src.params.seen) || src.now - 86400000;
      const c = (w) => countEvents(src, since, w);
      const visits = c("AND kind = 'visit'");
      const changes = eventsSince(src, since, "AND kind = 'change'").slice(0, 10);
      const reportWarn = src.deps.q("SELECT COUNT(*) AS n FROM reports WHERE hour >= ? AND sev IN ('warn','bad')", since - 3600000)[0].n;
      return [
        B.kv([
          ['Since', first ? C.txt('the last 24 hours', 'first visit on this browser') : C.time(since)],
          ['Warnings and failures', C.n(c("AND sev IN ('warn','bad')").n + reportWarn)],
          ['Visits', C.n(visits.n, visits.n ? (visits.teams ? `by ${visits.teams} team${visits.teams === 1 ? '' : 's'}` : 'no team chosen') : null)],
          ['Sign-ins', C.n(c("AND text = 'Signed in'").n, `${c("AND text = 'Sign-in failed'").n} failed`)],
          ['Admin actions', C.n(c("AND kind = 'admin'").n)],
          ['Exports and shares', C.n(c("AND kind = 'operation'").n)],
        ]),
        ...(changes.length ? [B.sub('Changes of state'), { t: 'feed', compact: true, items: feedRows(changes, []) }] : []),
        { t: 'seen' },
      ];
    },
  }),
  P('p-usage', 'Free-tier usage', {
    sub: 'Today against each free limit, counted by the site', live: true,
    sum: async (src) => {
      const u = await usage(src);
      const list = [['Worker requests', u.worker / LIMITS.worker], ['Durable Object requests', u.doReq / LIMITS.doReq], ['rows written', u.rowsW / LIMITS.rowsW], ['KV reads', u.kvR / LIMITS.kvR], ['KV writes', u.kvW / LIMITS.kvW]].sort((a, b) => b[1] - a[1]);
      const p = list[0][1];
      return [p > 0.9 ? 'bad' : p > 0.7 ? 'warn' : 'ok', `highest: ${list[0][0]} at ${(p * 100).toFixed(1)}%`];
    },
    body: async (src) => {
      const u = await usage(src);
      const wk = (k) => u.week.map((x) => x[k] || 0).concat([u[k] || 0]);
      return [{
        t: 'gauges', resetsAt: new Date(u.resetsAt).toISOString(), items: [
          gauge('Worker requests', u.worker, LIMITS.worker, { est: true, lines: BRAKE_LINES, spark: wk('worker'), note: 'every request the site served, recorded or not, and every cron run' }),
          gauge('Durable Object requests', u.doReq, LIMITS.doReq, { est: true, lines: BRAKE_LINES, spark: wk('doReq'), reserved: u.ftDo, caps: [[0.1, 'the log\'s budget: 10%'], [0.5, 'Fortune Teller\'s allowance: up to 50%']] }),
          gauge('Durable Object rows written', u.rowsW, LIMITS.rowsW, { est: true, lines: BRAKE_LINES, spark: wk('rowsW'), caps: [[0.1, 'the log\'s budget: 10%']] }),
          gauge('Durable Object rows read', u.rowsR, LIMITS.rowsR, { est: true, note: 'the log\'s own reads' }),
          gauge('KV reads', u.kvR, LIMITS.kvR, { est: true, lines: BRAKE_LINES, spark: wk('kvR') }),
          gauge('KV writes', u.kvW, LIMITS.kvW, { lines: BRAKE_LINES, spark: wk('kvW') }),
          gauge('Workers Logs events', u.logs, LIMITS.logs, { est: true }),
          gauge('R2 storage', u.r2Bytes, LIMITS.r2Bytes, { bytes: true, per: 'of 10 GB' }),
          gauge('R2 Class A operations', u.r2AMonth, LIMITS.r2A, { est: true, per: 'this month' }),
          gauge('R2 Class B operations', u.r2BMonth, LIMITS.r2B, { est: true, per: 'this month' }),
        ],
      }, brakeFacts(u), B.note('Daily limits reset at 00:00 UTC. These are the site\'s own counts: Cloudflare\'s exact figures need an API token, which setup does not ask for, so a count marked estimate can differ a little from the Cloudflare dashboard.')];
    },
  }),
  P('p-pages', 'Pages', {
    sub: 'Every page, its visitors and the health of what it reads', live: true,
    sum: async (src, ctx) => {
      const bad = PAGES.filter((p) => ['warn', 'bad'].includes(ctx.pageStates[p.key]));
      return [worst(PAGES.map((p) => ctx.pageStates[p.key])), `${PAGES.length} pages${bad.length ? `, ${bad.length} need${bad.length === 1 ? 's' : ''} a look` : ', all healthy'}`];
    },
    body: async (src, ctx) => {
      const day0 = Number(src.params.day0) || utcMidnight(src.now);
      const v = await visitsByPage(src, day0);
      const rows = (await src.hours(48)).filter((r) => r.hour >= hourOf(day0));
      const errs = {};
      for (const { d } of rows) for (const [k, r] of Object.entries(d.req || {})) { const p = pageForRoute(k); if (p) errs[p] = (errs[p] || 0) + (r.e || 0); }
      return [B.table([['Page'], ['Visits today', 'n'], ['Teams today', 'n'], ['Server errors', 'n'], ['Datasets in trouble', 'n'], ['Visibility']],
        PAGES.map((p) => {
          const up = upstream(p.datasets);
          const trouble = [...up.keys()].filter((k) => ctx.rowByKey[k] && ['warn', 'bad'].includes(ctx.rowByKey[k].sev)).length;
          const s = ctx.pageStates[p.key];
          return B.row([C.mix(C.dot(s, ''), C.tab(p.key, p.name)), C.n((v[p.key] || {}).n || 0), C.n((v[p.key] || {}).t || 0), C.n(errs[p.key] || 0),
            C.txt(`${trouble} of ${up.size}`, null, trouble ? 'warn' : null), pageVisibility(ctx.cfg, p)], s === 'bad' ? 'bad' : s === 'warn' ? 'warn' : null);
        })),
      B.note('Datasets in trouble counts a page\'s own datasets and everything they are built from. Today runs from midnight in your time zone.')];
    },
  }),
  P('p-live', 'Live activity', {
    sub: 'Visits, sign-ins, operations and status, newest first', live: true,
    sum: async (src) => {
      const e = latestEvents(src, '', 1)[0];
      return [null, e ? `latest ${agoText(src.now - e.at)}: ${e.text}` : 'nothing recorded yet'];
    },
    body: async (src) => {
      const rows = latestEvents(src, '', 25);
      const reports = src.deps.q('SELECT hour, sub, sev, text FROM reports WHERE hour >= ? ORDER BY hour DESC', src.now - 6 * 3600000);
      const items = feedRows(rows, reports).slice(0, 25);
      return items.length ? [{ t: 'feed', compact: true, items }, B.btn('Open the full log', 'activity')]
        : [B.empty('Nothing recorded yet. Visits, sign-ins and changes of state appear here as they happen.')];
    },
  }),
  P('p-traffic', 'Traffic', {
    sub: 'Requests per hour for the last 48 hours', live: true,
    sum: async (src) => {
      const rows = await src.hours(48);
      const cur = rows.filter((r) => r.hour === hourOf(src.now));
      return [null, `${servedReq(cur).toLocaleString('en-US')} requests this hour`];
    },
    body: async (src) => {
      const rows = await src.hours(48);
      const hours = [];
      for (let i = 47; i >= 0; i--) {
        const h = hourOf(src.now) - i * 3600000;
        const r = rows.find((x) => x.hour === h);
        const byPage = {}; let polls = 0, total = 0;
        for (const [k, v] of Object.entries((r && r.d.req) || {})) {
          const p = pageForRoute(k) || 'other';
          byPage[p] = (byPage[p] || 0) + (v.n || 0);
          total += v.n || 0;
          if (/\/api\/(dashboard\/status|live\/week|live\/timeline|data(\/|$)|fortune-teller$)|site-backend\/api/.test(k)) polls += v.n || 0;
        }
        // Requests served but never recorded (the health check, the tab icon, the developer hooks) count as other.
        const served = r ? servedReq([r]) : 0;
        if (served > total) { byPage.other = (byPage.other || 0) + (served - total); total = served; }
        hours.push({ at: new Date(h).toISOString(), byPage, cron: r ? Object.keys(r.d.ticks || {}).length : 0, total, polls, errors: r ? sumReq([r]).e + (r.d.exc || 0) : 0 });
      }
      const busiest = hours.reduce((a, h) => (h.total > (a ? a.total : -1) ? h : a), null);
      const all = hours.reduce((a, h) => a + h.total, 0), polls = hours.reduce((a, h) => a + h.polls, 0);
      return [{ t: 'traffic', hours, pages: PAGES.map((p) => [p.key, p.name]) },
        B.kv([
          ['Busiest hour', busiest && busiest.total ? C.at(busiest.at, `${busiest.total.toLocaleString('en-US')} requests`) : '—'],
          ['Polling share', all ? C.pct(polls / all, 'of page and API requests') : '—'],
          ['Requests, 48 h', C.n(all)],
          ['Server errors, 48 h', C.n(hours.reduce((a, h) => a + h.errors, 0))],
        ])];
    },
  }),
  P('p-ds', 'Datasets', {
    sub: 'Everything the site stores, fresh or resting', asof: 'ages update every second',
    sum: async (src, ctx) => {
      const c = { ok: 0, idle: 0, bad: 0 };
      for (const r of ctx.rows) { if (r.sev === 'ok') c.ok++; else if (r.sev === 'idle') c.idle++; else c.bad++; }
      return [worst(ctx.rows.map((r) => r.sev)), `${c.ok} fresh, ${c.idle} resting or manual${c.bad ? `, ${c.bad} in trouble` : ''}`];
    },
    body: async (src, ctx) => {
      const params = await paramRows(src);
      return [{ t: 'datasets', rows: ctx.rows, param: params }];
    },
  }),
  P('p-cron', 'Scheduled work', {
    sub: 'The minute schedule and what each run did', live: true,
    sum: async (src, ctx) => (ctx.lastTick == null ? [ctx.finished ? 'warn' : null, 'no tick recorded yet'] : !ctx.cronCounted ? ['ok', 'ticking; the log has only just started'] : [ctx.cronMissed >= CRON_MISS_WARN ? 'warn' : 'ok', `${ctx.cronCounted - ctx.cronMissed} of ${ctx.cronCounted} ticks ${ctx.cronCounted < 60 ? 'since the log started' : 'in the last hour'}`]),
    body: async (src, ctx) => cronBody(src, ctx),
  }),
  P('p-do', 'Durable Objects', {
    sub: 'Each class, its instances and what it holds', live: true,
    sum: async (src, ctx) => [ctx.window.open || (ctx.ftp && ['building', 'updating'].includes(ctx.ftp.state)) ? 'run' : 'ok', `${doClassCount(src.env)} classes; this week's timeline at ${Math.round(ctx.timelinePct * 100)}% of its budget`],
    body: async (src, ctx) => doBody(src, ctx),
  }),
  P('p-storage', 'Storage', {
    sub: 'R2, KV and the edge cache',
    sum: async (src) => { const c = await src.census(); return [null, c ? `R2 ${fmtB(c.total.bytes)} in ${c.total.objects.toLocaleString('en-US')} objects` : 'first census within 10 minutes']; },
    body: async (src) => storageBody(src),
  }),
  P('p-espn', 'ESPN connection', {
    sub: 'The league\'s cookies, each host, and calls made outside the dataset registry', live: true,
    sum: async (src, ctx) => (ctx.espn.failing ? ['bad', 'cookies refused'] : ['ok', 'cookies accepted']),
    body: async (src, ctx) => espnBody(src, ctx),
  }),
  P('p-signin', 'Sign-in', {
    sub: 'Today\'s sign-ins, failures, blocks and Admin Password checks', live: true,
    sum: async (src) => { const d0 = Number(src.params.day0) || utcMidnight(src.now); return [null, `${countEvents(src, d0, "AND text = 'Signed in'").n} sign-ins today, ${countEvents(src, d0, "AND text = 'Sign-in failed'").n} failed`]; },
    body: async (src) => {
      const d0 = Number(src.params.day0) || utcMidnight(src.now);
      const c = (w) => C.n(countEvents(src, d0, w).n);
      return [B.kv([['Signed in', c("AND text = 'Signed in'")], ['Failed', c("AND text = 'Sign-in failed'")], ['Blocked by the throttle', c("AND text = 'Sign-in blocked by the throttle'")],
        ['Admin Password accepted', c("AND kind = 'admin' AND text LIKE 'Admin Password accepted%'")], ['Admin Password refused', c("AND kind = 'admin' AND text LIKE 'Admin Password refused%'")],
        ['Sessions lapsed', c("AND text = 'Session lapsed'")], ['Signed out', c("AND text = 'Signed out'")]]), B.btn('Open the Sign-in tab', 'signin')];
    },
  }),
  P('p-ft', 'Fortune Teller', {
    sub: 'The pipeline, and any build or update running', live: true,
    sum: async (src, ctx) => (ctx.ftp ? [ftSev(ctx.ftp.state), `${ctx.ftp.state}${ctx.ftp.state === 'early' && ctx.ftp.opensAfterWeek ? `: opens after week ${ctx.ftp.opensAfterWeek}` : ''}${ctx.ftp.build && ctx.ftp.build.parts ? '' : ''}`] : [null, 'no pipeline check yet']),
    body: async (src, ctx) => {
      const p = ctx.ftp;
      if (!p) return [B.empty('The pipeline has not run a check yet. It checks every 15 minutes once setup has finished.'), B.btn('Open the Fortune Teller tab', 'fortune-teller')];
      const b = p.build;
      return [B.kv([['State', C.pill(ftSev(p.state), p.state)], ['Switched on', C.txt(p.enabled ? 'yes' : 'no')], ['Last check', C.time(p.checkedAt, p.reason ? `reason: ${p.reason}` : null)],
        ['Weeks settled', C.txt(`${p.lastSettled ?? '?'} of ${p.mpc ?? '?'}`)], ['Opens after', p.opensAfterWeek ? C.txt(`week ${p.opensAfterWeek}`) : '—'],
        ['A build now', p.estimate ? C.txt(`${fmtPaths(p.estimate.paths)} paths`, aboutHours(p.estimate.hours)) : '—'],
        b ? ['Running', C.txt(`${b.kind} ${b.state}`, b.team != null ? `team ${b.team + 1} of ${b.n}` : null)] : null]),
        ...(b && b.n ? [B.progress(((b.team || 0) + ((b.part || 0) / Math.max(1, b.parts || 1))) / b.n)] : []),
        B.btn('Open the Fortune Teller tab', 'fortune-teller')];
    },
  }),
  P('p-livescore', 'Live scoring and timeline', {
    sub: 'The game window and this week\'s recording', live: true,
    sum: async (src, ctx) => (ctx.window.open ? ['run', 'a game window is open'] : [null, ctx.window.next ? `next kickoff ${agoText(ctx.window.next - src.now, true)}` : 'no kickoff scheduled']),
    body: async (src, ctx) => liveBody(src, ctx),
  }),
  P('p-logos', 'Logos', {
    sub: 'Every team\'s logo, copied from ESPN every five minutes', live: true,
    sum: async (src, ctx) => { const t = Object.keys(ctx.logoState).length; return [ctx.logosFailing.length ? 'warn' : 'ok', t ? `${t - ctx.logosFailing.length} of ${t} current` : 'no logo pass yet']; },
    body: async (src, ctx) => logosBody(src, ctx),
  }),
  P('p-config', 'Configuration', {
    sub: 'Every setting, with secrets shown only as present or not',
    sum: async (src, ctx) => {
      if (!ctx.finished) return ['bad', 'setup not finished'];
      const n = TOOLS.filter((t) => visibilityOf(ctx.cfg, t.key) === VISIBILITY.ADMIN).length;
      const at = Date.parse(ctx.cfg.setupCompletedAt);
      return [null, `set up ${Number.isFinite(at) ? agoText(src.now - at) : 'earlier'}; ${n ? `${n} ${n === 1 ? 'tool' : 'tools'} admin-only` : 'no tools admin-only'}`];
    },
    body: async (src, ctx) => configBody(src, ctx),
  }),
  P('p-deploy', 'Deployment', {
    sub: 'Version, Worker settings, bindings, bundles, this isolate and your connection',
    sum: async (src) => { const vm = src.facts.versionMetadata; return [null, `${src.facts.build}${vm && vm.timestamp ? `, deployed ${agoText(src.now - Date.parse(vm.timestamp))}` : ''}`]; },
    body: async (src) => deployBody(src),
  }),
  P('p-league', 'League and NFL', {
    sub: 'Season facts, rules and this NFL week',
    sum: async (src) => { const s = await src.settings(); return [null, s ? `${s.s.name || 'League'}: week ${s.status.currentMatchupPeriod} of ${(s.s.scheduleSettings || {}).matchupPeriodCount}` : 'league settings not stored yet']; },
    body: async (src, ctx) => leagueBody(src, ctx),
  }),
  P('p-updates', 'Update compatibility', {
    sub: 'The update notice members see, and whether a re-pull is needed',
    sum: async (src, ctx) => { const miss = ctx.rows.filter((r) => r.state === 'missing' && r.tier !== 'probe').length; return [miss ? 'warn' : 'ok', `version ${src.facts.version}; ${miss ? 're-pull needed' : 'no re-pull needed'}`]; },
    body: async (src, ctx) => {
      const miss = ctx.rows.filter((r) => r.state === 'missing' && r.tier !== 'probe');
      return [B.sub(`The update notice for version ${src.facts.version}`), B.list(src.facts.releaseItems || RELEASE_NOTE_ITEMS),
        B.kv([['Re-pull banner', miss.length ? C.pill('warn', 'showing', `${miss.length} dataset${miss.length === 1 ? '' : 's'} never fetched`) : C.txt('not needed')],
          ['Datasets last checked for', C.txt(ctx.cfg.datasetsCheckedVersion || 'not yet')],
          ['Box-score history re-pull', C.txt(src.facts.needsHistoryRepull ? 'asked for by this release' : 'not needed')]]),
        ...(miss.length ? [B.sub('Never fetched on this deployment'), B.list(miss.map((m) => `${m.key}: ${m.label}`))] : [])];
    },
  }),
  P('p-security', 'Security self-check', {
    sub: 'What the running build enforces',
    sum: async (src) => { const c = securityChecks(src); const f = c.filter((x) => !x[0]).length; return [f ? 'warn' : 'ok', `${c.length - f} of ${c.length} checks pass`]; },
    body: async (src) => [B.checks(securityChecks(src))],
  }),
  P('p-nc', 'Not collectable', {
    sub: 'What the site cannot see from inside',
    sum: async () => [null, '6 things the site cannot see'],
    body: async () => [B.list([
      'CPU time per request: the runtime does not expose it, and its clock only moves across I/O, so durations here are wall time.',
      'Exact account-wide usage: only Cloudflare\'s analytics API has it, and that needs a token setup does not ask for.',
      'The Worker\'s own script size: known only to wrangler when it deploys.',
      'Workers Logs: readable in the Cloudflare dashboard only.',
      'Which person is which: a visit is someone viewing as a team, chosen on that browser; the League Password is shared, and IP addresses, locations and devices are never recorded.',
      'Browser-only state: which release notes a browser has seen, and a tab\'s idle pause.',
    ])],
  }),
];

// ---------------------------------------------------------------- bodies

export function agoText(ms, future = false) {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const t = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  return future ? `in ${t}` : `${t} ago`;
}
export const fmtB = (n) => { if (n == null) return '—'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return `${i ? v.toFixed(v < 10 ? 2 : 1) : v} ${u[i]}`; };
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
/** A path count as a reader says it; past a thousand trillion, in powers of ten. */
export const fmtPaths = (p) => {
  if (!Number.isFinite(p)) return 'uncountably many';
  if (p >= 1e15) { const e = Math.floor(Math.log10(p)); return `${(p / 10 ** e).toFixed(1)} × 10${String(e).split('').map((d) => SUP[d]).join('')}`; }
  return p >= 1e12 ? `${(p / 1e12).toFixed(2)} trillion` : p >= 1e9 ? `${(p / 1e9).toFixed(2)} billion` : p >= 1e6 ? `${(p / 1e6).toFixed(1)} million` : Math.round(p).toLocaleString('en-US');
};
/** The same, as a subtitle: 'about 17 days', but never 'about far beyond reach'. */
export const aboutHours = (h) => { const t = fmtHours(h); return /^\d/.test(t) ? `about ${t}` : t; };
/** A build's length in the largest unit that reads naturally; past a thousand years it is simply out of reach. */
export const fmtHours = (h) => {
  if (!Number.isFinite(h) || h > 24 * 365 * 1000) return 'far beyond reach';
  const m = Math.round(h * 60);
  if (m < 1) return 'under a minute';
  if (h < 1) return m === 1 ? '1 minute' : `${m} minutes`;
  if (h < 48) return `${h.toFixed(1)} hours`;
  if (h < 24 * 365) return `${Math.round(h / 24).toLocaleString('en-US')} days`;
  return `${Math.round(h / 24 / 365).toLocaleString('en-US')} years`;
};

/**
 * Which clock kept each minute (C5): of the minutes with a tick, how many the backend clock's alarm did, how many the
 * cron's knock did, how many the cron did itself (where the clock is off, or as a fallback), and how late the work
 * began. A plain function of the stored ticks, tested by behaviour.
 */
export function clockSummary(ticks, since = 0) {
  const by = { alarm: 0, knock: 0, cron: 0 }, lates = [];
  // Minutes in which each clock was heard at all, among the minutes that say (the one that arrives second does no work).
  const heard = { judged: 0, alarm: 0, knock: 0 };
  let fallback = 0, minutes = 0;
  for (const [m, t] of Object.entries(ticks || {})) {
    if (Number(m) < since) continue;
    const c = t && t.clock;
    minutes += 1;
    if (!c) { by.cron += 1; continue; }
    by[c.via] = (by[c.via] || 0) + 1;
    if (c.fallback) fallback += 1;
    if (c.ha != null) { heard.judged += 1; heard.alarm += c.ha ? 1 : 0; heard.knock += c.hk ? 1 : 0; }
    if (Number.isFinite(c.late)) lates.push(c.late);
  }
  lates.sort((a, b) => a - b);
  const med = lates.length ? lates[Math.floor(lates.length / 2)] : null;
  return { minutes, by, heard, fallback, late: { median: med, max: lates.length ? lates[lates.length - 1] : null }, clockOn: by.alarm + by.knock > 0 };
}

/* ---------------------------------------------------------------- the Data Layer tab (C9)
   The dev portal's data-layer status, adapted to Site Backend's panels: read-only, redacted by the same rules,
   every panel shut until opened. Duplication with the Overview is welcome: a dataset read by many places appears
   in each. */

/** The dataset coordinators' work today, per dataset, from the hourly tallies they hand to the log. */
export function coordinatorTotals(rows) {
  const per = {};
  for (const { d } of rows) {
    for (const [k, t] of Object.entries(d.ds || {})) {
      const x = per[k] || (per[k] = { req: 0, sweeps: 0, coalesced: 0, fetched: 0, failed: 0, bytes: 0, ms: 0 });
      for (const f of Object.keys(x)) x[f] += Number(t[f]) || 0;
    }
  }
  return Object.entries(per).map(([key, t]) => ({ key, ...t })).sort((a, b) => b.req - a.req || a.key.localeCompare(b.key));
}

export const DATA_LAYER = [
  P('dl-ds', 'Every dataset', {
    sub: 'Raw and derived: state, parts, stored size, age against its interval, last fetch and failure, what it derives from', asof: 'ages update every second',
    sum: async (src, ctx) => {
      const c = { ok: 0, idle: 0, bad: 0 };
      for (const r of ctx.rows) { if (r.sev === 'ok') c.ok++; else if (r.sev === 'idle') c.idle++; else c.bad++; }
      return [worst(ctx.rows.map((r) => r.sev)), `${ctx.rows.length} datasets: ${c.ok} fresh, ${c.idle} resting or manual${c.bad ? `, ${c.bad} in trouble` : ''}`];
    },
    body: async (src, ctx) => [{ t: 'datasets', rows: ctx.rows, param: await paramRows(src) }],
  }),
  P('dl-coord', 'Coordinators', {
    sub: 'Each dataset\'s coordinator today: refreshes asked for, joined and fetched, failures and time', live: true,
    sum: async (src) => {
      const day = (await src.hours(48)).filter((r) => r.hour >= utcMidnight(src.now));
      const t = coordinatorTotals(day);
      const f = t.reduce((a, x) => a + x.failed, 0);
      return [f ? 'warn' : 'ok', `${t.reduce((a, x) => a + x.req, 0).toLocaleString('en-US')} refreshes asked for today${f ? `, ${f} failed` : ''}`];
    },
    body: async (src) => {
      const day = (await src.hours(48)).filter((r) => r.hour >= utcMidnight(src.now));
      const t = coordinatorTotals(day);
      if (!t.length) return [B.empty('No coordinator has handed over a tally yet today. Each hands over on its dataset\'s first refresh after the hour turns.')];
      return [B.table([['Dataset'], ['Asked', 'n'], ['Sweeps', 'n'], ['Joined', 'n'], ['Fetched', 'n'], ['Failed', 'n'], ['Received', 'n'], ['Time', 'n']],
        t.map((x) => B.row([C.code(x.key), C.n(x.req), C.n(x.sweeps), C.n(x.coalesced), C.n(x.fetched), x.failed ? C.txt(String(x.failed), null, 'warn') : C.n(0), C.bytes(x.bytes), C.dur(x.ms)], x.failed ? 'warn' : null))),
      B.note('A coordinator is one Durable Object per dataset: two pages asking for the same stale dataset at once share one refresh (joined). Tallies arrive hourly, so the current hour fills in as each dataset next refreshes.')];
    },
  }),
  P('dl-espn', 'ESPN hosts', {
    sub: 'The league\'s cookies, each host the site reaches, and calls made outside the dataset registry', live: true,
    sum: async (src, ctx) => (ctx.espn.failing ? ['bad', 'cookies refused'] : ['ok', 'cookies accepted']),
    body: async (src, ctx) => espnBody(src, ctx),
  }),
  P('dl-repull', 'Re-pull state', {
    sub: 'Whether an update left anything unfetched, and the past-seasons pull',
    sum: async (src, ctx) => { const miss = ctx.rows.filter((r) => r.state === 'missing' && r.tier !== 'probe').length; return [miss ? 'warn' : 'ok', miss ? `${miss} dataset${miss === 1 ? '' : 's'} never fetched` : 'nothing to re-pull']; },
    body: async (src, ctx) => {
      const miss = ctx.rows.filter((r) => r.state === 'missing' && r.tier !== 'probe');
      return [B.kv([['Re-pull banner on the home page', miss.length ? C.pill('warn', 'showing', `${miss.length} dataset${miss.length === 1 ? '' : 's'} never fetched`) : C.txt('not needed')],
        ['Datasets last checked for', C.txt(ctx.cfg.datasetsCheckedVersion || 'not yet')],
        ['Box-score history re-pull', C.txt(src.facts.needsHistoryRepull ? 'asked for by this release' : 'not needed')]]),
      ...(miss.length ? [B.sub('Never fetched on this deployment'), B.list(miss.map((m) => `${m.key}: ${m.label}`))] : []),
      B.note('A re-pull is started from Site Configuration, which asks for the Admin Password; Site Backend only reads.')];
    },
  }),
];

/** The Data Layer tab's strip: how many datasets, how fresh, how much is stored. */
export function dataStrip(src, ctx) {
  const rows = ctx.rows;
  return { kv: [
    ['Datasets', C.n(rows.length, `${rows.filter((r) => r.derivedFrom).length} derived`)],
    ['Fresh', C.n(rows.filter((r) => r.state === 'fresh').length)],
    ['In trouble', C.n(rows.filter((r) => r.sev === 'warn' || r.sev === 'bad').length)],
    ['Stored', C.bytes(rows.reduce((a, d) => a + (d.bytes || 0), 0))],
  ] };
}

async function cronBody(src, ctx) {
  const now = src.now, minute = Math.floor(now / 60000) * 60000;
  const last = ctx.ticks[ctx.lastTick] || {};
  const job = (name) => last[name] || {};
  const tl = job('timeline'), lg = job('logos'), fc = job('ft'), nd = job('nudge');
  const m5 = Math.floor(now / 300000) * 300000, m15 = Math.floor(now / 900000) * 900000;
  const lastOf = (pred) => { const ks = Object.keys(ctx.ticks).map(Number).sort((a, b) => b - a); return ks.find((k) => pred(ctx.ticks[k])) || null; };
  const lastLogo = lastOf((t) => t && t.logos && t.logos.ran);
  const lastFt = lastOf((t) => t && t.ft && t.ft.ran);
  const rows = [
    [C.dot(ctx.window.open ? 'run' : 'idle', 'Score timeline'), 'every minute', C.time(ctx.lastTick), C.txt(tl.recorded ? `recorded ${tl.matchups || 0} matchups` : tl.skipped ? `skipped: ${tl.skipped}` : tl.error ? `failed: ${tl.error}` : '—', null, tl.error ? 'bad' : null), C.time(minute + 60000), tl.ms != null ? C.dur(tl.ms) : '—'],
    [C.dot(lg.failed ? 'warn' : 'ok', 'Logo pass'), 'every 5 minutes', C.time(lastLogo), C.txt(lastLogo ? (() => { const t = ctx.ticks[lastLogo].logos; return `${t.seen || 0} checked, ${t.changed || 0} changed, ${t.failed || 0} failing`; })() : 'not run in the last hour'), C.time(m5 + 300000), lastLogo ? C.dur(ctx.ticks[lastLogo].logos.ms || 0) : '—'],
    [C.dot('ok', 'Fortune Teller check'), 'every 15 minutes', C.time(lastFt), C.txt(lastFt ? (ctx.ticks[lastFt].ft.state || 'checked') : 'not run in the last hour'), C.time(m15 + 900000), lastFt ? C.dur(ctx.ticks[lastFt].ft.ms || 0) : '—'],
    [C.dot(nd.ran ? 'run' : 'idle', 'Fortune Teller build nudge'), 'every minute while a build runs', C.time(ctx.lastTick), C.txt(nd.result || '—'), C.time(minute + 60000), nd.ms != null ? C.dur(nd.ms) : '—'],
    [C.dot('ok', 'Site log tick'), 'every minute', C.time(ctx.lastTick), C.txt('recorded'), C.time(minute + 60000), '—'],
  ];
  const cells = [];
  for (let i = 59; i >= 0; i--) { const m = minute - i * 60000; const st = tickState(ctx, m, now); cells.push({ at: new Date(m).toISOString(), s: st === 'pending' ? 'none' : st }); }
  const cs = clockSummary(ctx.ticks, src.now - 3600000);
  const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
  const clockRows = cs.clockOn ? [B.sub('Which clock kept each minute, this hour'), B.kv([
    ['The clock’s own alarm', C.n(cs.by.alarm, cs.heard.judged ? `fired in ${cs.heard.alarm} of ${cs.heard.judged} minutes` : null)],
    ['The cron’s knock', C.n(cs.by.knock, cs.heard.judged ? `arrived in ${cs.heard.knock} of ${cs.heard.judged} minutes` : null)],
    ['The cron by itself (the clock unreachable)', C.n(cs.fallback)],
    ['Work began, typically', C.txt(`${secs(cs.late.median)} into the minute`)], ['Latest start', C.txt(`${secs(cs.late.max)} into the minute`)],
  ])] : [];
  return [B.table([['Job'], ['Runs'], ['Last run', 'n'], ['Result'], ['Next run', 'n'], ['Took', 'n']], rows.map((r) => B.row(r))),
    B.sub('Ticks in the last hour, oldest first'), { t: 'cells', items: cells }, ...clockRows,
    B.note(cs.clockOn
      ? 'The backend clock, one Durable Object, does every job above once a minute: from its own alarm or the cron\'s knock, whichever comes first, with 30 s of CPU. If the knock cannot reach the clock, the cron does the work itself.'
      : 'One schedule, * * * * *, runs every job above, with 10 ms of CPU each run; heavier work is handed to a Durable Object.')];
}

async function doBody(src, ctx) {
  const peek = await src.ftPeek();
  const m = src.meter();
  const rows = [
    [C.dot('ok', 'DatasetCoordinator'), C.code('COORDINATOR'), C.txt(`one per dataset: ${DATASETS.length} registered`), C.txt('refresh counters per dataset')],
    [C.dot('ok', 'LoginThrottle'), C.code('THROTTLE'), C.txt('one per IP address; cannot be listed'), C.txt('failed sign-ins in the last 10 minutes')],
    [C.dot(ctx.window.open ? 'run' : 'idle', 'ScoreTimelineDO'), C.code('SCORE_TIMELINE'), C.txt(`one per week: ${(ctx.timelineWeeks || []).length} so far`), C.txt('scores, win chances and projections through each game window')],
    [C.dot(ctx.ftp && ['building', 'updating'].includes(ctx.ftp.state) ? 'run' : 'ok', 'FortuneTellerDO'), C.code('FORTUNE'), C.txt('one: fortune-teller'), peek ? C.txt(`job, meter, settings and log`, peek.dbBytes ? fmtB(peek.dbBytes) : null) : C.txt('—')],
    [C.dot(m.paused ? 'warn' : 'ok', 'SiteLogDO'), C.code('SITE_LOG'), C.txt(`one per season: site-log-${ctx.cfg.season}`), C.txt(`${fmtB(src.deps.size())} of 1 GB`, `${m.req.toLocaleString('en-US')} requests, ${m.rows.toLocaleString('en-US')} rows written today`)],
  ];
  // Site API's pace record and the backend clock (C5), where the deployment binds them.
  if (src.env && src.env.SOURCE_PACE) rows.push([C.dot('ok', 'SourcePaceDO'), C.code('SOURCE_PACE'), C.txt('one per key and address; cannot be listed'), C.txt('each program\'s round and pace, and when the address\'s recent rounds began')]);
  if (src.env && src.env.CLOCK) {
    const u = clockUse(src.env, clockSummary(ctx.ticks, src.now - 3600000));
    rows.push([C.dot(u.s, 'BackendClockDO'), C.code('CLOCK'), C.txt('one: clock'), C.txt(u.holds)]);
  }
  const weeks = ctx.timelineWeeks || [];
  return [B.table([['Class'], ['Binding'], ['Instances'], ['Holds']], rows.map((r) => B.row(r))),
    ...(weeks.length ? [B.sub('Score timeline, bytes per week against its 96 KB budget'), B.bars(weeks.map((w) => ({ l: C.txt(`Week ${w.week}`, `${(w.rows || 0).toLocaleString('en-US')} rows, ${(w.events || 0).toLocaleString('en-US')} events`), v: w.bytes || 0, max: BYTE_BUDGET, r: C.bytes(w.bytes || 0), s: (w.bytes || 0) > BYTE_BUDGET * 0.8 ? 'warn' : null })))] : []),
    B.note(`All ${DO_WORDS[rows.length] || rows.length} classes keep their data in SQLite. One stored value may reach 2 MB and one object 1 GB on the Free plan; the timeline holds each week under a 96 KB budget of its own.`)];
}

const DO_WORDS = { 5: 'five', 6: 'six', 7: 'seven' };
/** How many Durable Object classes the Durable Objects panel lists: five always, plus the two a deployment may bind. */
export function doClassCount(env) { return 5 + (env && env.SOURCE_PACE ? 1 : 0) + (env && env.CLOCK ? 1 : 0); }
/** The backend clock's row: in use where the deployment switches it on, otherwise bound and idle (the cron works). */
export function clockUse(env, cs) {
  const on = String((env && env.BACKEND_CLOCK) || '').toLowerCase() === 'on';
  return { on, s: !on ? 'idle' : cs && cs.fallback ? 'warn' : 'ok', holds: on ? 'the last minute it kept, and its alarm' : 'bound but not in use: the cron does the minute\'s work' };
}

async function storageBody(src) {
  const c = await src.census();
  const u = await usage(src);
  const blocks = [];
  if (c) {
    blocks.push(B.table([['R2 prefix'], ['Objects', 'n'], ['Size', 'n'], ['Newest', 'n']],
      c.prefixes.map((p) => B.row([C.code(p.prefix), C.n(p.objects), C.bytes(p.bytes), p.newest ? C.time(p.newest) : '—']))
        .concat([B.row([C.txt('Total'), C.n(c.total.objects), C.bytes(c.total.bytes), C.txt(`${((c.total.bytes / LIMITS.r2Bytes) * 100).toFixed(2)}% of 10 GB`)])])));
    blocks.push(B.kv([['Census taken', C.time(c.at)], ['Next census', C.time(Date.parse(c.at) + 600000)]]));
  } else blocks.push(B.empty('The first storage census runs within ten minutes of the log starting.'));
  const kv = [];
  for (const [k, what] of [['config:v1', 'setup, credentials (hashed or hidden), tool visibility, weighting, switches'], ['config:espn_auth', 'whether ESPN is refusing the league\'s cookies']]) {
    let size = null;
    try { const v = await src.env.CONFIG.get(k); size = v == null ? null : new TextEncoder().encode(v).length; } catch { size = null; }
    kv.push(B.row([C.code(k), size == null ? C.txt('absent') : C.bytes(size), C.txt(what)]));
  }
  blocks.push(B.sub('KV'), B.table([['Key'], ['Size', 'n'], ['Holds']], kv));
  blocks.push(B.sub('Edge cache (logos and images)'), B.kv([['Hits today', C.n(u.cacheHit)], ['Misses today', C.n(u.cacheMiss)]]));
  blocks.push(B.note('Listing R2 costs Class A operations, so the census counts every prefix once every ten minutes rather than on each refresh. The edge cache itself cannot be listed.'));
  return blocks;
}

async function espnBody(src, ctx) {
  const rows = await src.hours(24);
  const hosts = {};
  for (const { d } of rows) for (const [h, x] of Object.entries(d.hosts || {})) {
    const t = hosts[h] || (hosts[h] = { n: 0, f: 0, ms: [], fb: 0, last: null });
    t.n += x.n; t.f += x.f; t.fb += x.fb || 0; t.ms.push(...(x.ms || []));
    if (x.last && (!t.last || x.last.at > t.last.at)) t.last = x.last;
  }
  const hostRows = Object.entries(hosts).sort((a, b) => b[1].n - a[1].n).map(([h, t]) => B.row([
    C.code(h), t.last ? C.pill(t.last.status >= 200 && t.last.status < 300 ? 'ok' : 'bad', String(t.last.status || 'error')) : '—',
    t.ms.length ? C.dur(median(t.ms)) : '—', C.n(t.n), C.n(t.f, null), C.n(t.fb)], t.f ? 'warn' : null));
  const statuses = await src.statuses() || {};
  let lastOkAt = null, lastFailAt = null;
  for (const d of DATASETS.filter((x) => x.auth && !x.derivedFrom)) {
    const st = statuses[d.key] && statuses[d.key].doc;
    if (!st) continue;
    if (st.ok !== false && (!lastOkAt || st.startedAt > lastOkAt)) lastOkAt = st.startedAt;
    if (st.ok === false && (!lastFailAt || st.startedAt > lastFailAt)) lastFailAt = st.startedAt;
  }
  const jobs = await src.jobs();
  const h = jobs.history;
  let logoCalls = 0;
  for (const t of Object.values(ticksOf(rows))) if (t && t.logos && t.logos.ran) logoCalls += (t.logos.fetched || 0);
  return [
    B.kv([['Cookies', ctx.espn.failing ? C.pill('bad', 'refused', ctx.espn.status ? `HTTP ${ctx.espn.status}` : null) : C.pill('ok', 'accepted')],
      ['Refused since', ctx.espn.failing ? C.time(ctx.espn.since) : '—'],
      ['Last signed-in refresh that worked', C.time(lastOkAt)], ['Last one that failed', C.time(lastFailAt)]]),
    B.sub('ESPN hosts, last 24 hours'),
    hostRows.length ? B.table([['Host'], ['Last status'], ['Median', 'n'], ['Calls', 'n'], ['Failed', 'n'], ['Fallback host', 'n']], hostRows)
      : B.empty('No refreshes recorded in the last 24 hours. Each dataset\'s coordinator hands over its hourly tally on its first refresh after the hour turns.'),
    B.sub('Calls outside the dataset registry'),
    B.table([['What'], ['Last 24 hours', 'n'], ['How often']], [
      B.row([C.txt('Logo copies'), C.n(logoCalls), C.txt('only when a team\'s logo changes; checked every 5 minutes')]),
      B.row([C.txt('Fortune Teller roster projections'), C.txt('—'), C.txt('at most one per remaining week, when a build or update starts')]),
      B.row([C.txt('Box-score history'), C.txt(h ? (h.complete ? 'complete' : 'in progress') : 'not run'), C.txt(h ? `${(h.eventsDone || 0).toLocaleString('en-US')} of ${(h.eventsTotal || 0).toLocaleString('en-US')} box scores` : 'run from setup or Site Configuration')]),
    ]),
  ];
}

async function liveBody(src, ctx) {
  const w = ctx.window;
  const lsd = await src.digest('live_scoring_digest');
  const inPlay = lsd ? (lsd.games || []).filter((g) => g.state === 'live').length : 0;
  const cur = (ctx.timelineWeeks || []).find((x) => lsd && x.week === lsd.matchupPeriod);
  return [B.kv([['Game window', w.open ? C.pill('run', 'open', w.closes ? null : null) : C.txt('closed')],
    ['Closes', w.open ? C.time(w.closes) : '—'], ['Next kickoff', C.at(w.next)],
    ['NFL games this week', C.txt(`${w.live} live`, `${w.final} final, ${w.upcoming} upcoming`)],
    ['Fantasy matchups in play', C.txt(`${inPlay} of ${lsd ? (lsd.games || []).length : '?'}`)],
    ['Timeline, this week', cur ? C.bytes(cur.bytes, `${Math.round((cur.bytes / BYTE_BUDGET) * 100)}% of its 96 KB budget`) : C.txt('not recorded yet')],
    ['Last timeline row', (() => { const ks = Object.keys(ctx.ticks).map(Number).sort((a, b) => b - a); const k = ks.find((m) => ctx.ticks[m] && ctx.ticks[m].timeline && ctx.ticks[m].timeline.recorded); return k ? C.time(k) : C.txt('none in the last hour'); })()],
    ['Scoreboard read', C.time(w.generatedAt)]])];
}

async function logosBody(src, ctx) {
  const list = await src.logos() || [];
  const teams = await src.teams();
  const byTeam = new Map(list.map((o) => [o.key.replace(/^logos\//, '').replace(/\.[a-z]+$/, ''), o]));
  const ids = Object.keys(teams).length ? Object.keys(teams) : [...byTeam.keys()];
  const rows = ids.map((id) => {
    const o = byTeam.get(String(id));
    const st = ctx.logoState[String(id)];
    const src2 = o && o.meta && o.meta.source ? (/fantasy\.espn|espncdn\.com\/i\/teamlogos\/.*\/fantasy/i.test(o.meta.source) ? 'ESPN artwork' : 'uploaded to ESPN') : 'none (shield)';
    return B.row([C.team(id), C.txt(src2), o ? C.bytes(o.size) : '—', o && o.meta && o.meta.fetchedAt ? C.time(o.meta.fetchedAt) : '—',
      st === 'failed' ? C.txt('failing; stored copy served', null, 'warn') : C.txt(o ? 'OK' : 'no logo set')], st === 'failed' ? 'warn' : null);
  });
  return rows.length ? [B.table([['Team'], ['Source'], ['Size', 'n'], ['Copied', 'n'], ['Last pass']], rows)] : [B.empty('No logos stored yet. The first logo pass runs within five minutes of setup finishing.')];
}

async function configBody(src, ctx) {
  const cfg = ctx.cfg, d = describeConfig(cfg), st = cfg.stamps || {};
  const stamp = (k) => (st[k] ? C.time(st[k]) : C.txt('—'));
  const moved = TRADE_ROWS.filter((r) => cfg.tradeWeights && cfg.tradeWeights[r.id] != null && cfg.tradeWeights[r.id] !== r.w);
  return [
    B.kv([['League ID', C.txt(String(d.leagueId || 'not set'))], ['Season', C.txt(String(d.season), 'from the date')], ['Private league', C.txt(d.leaguePrivate ? 'yes' : 'no')],
      ['History seasons', C.txt((d.historySeasons || []).join(', ') || 'none', d.historyDiscovered ? 'discovered' : null)],
      ['Setup finished', C.at(d.setupCompletedAt)],
      ['espn_s2', d.espnS2Present ? C.hidden(`present, ${d.espnS2Length} characters`) : C.txt('missing', null, 'bad')],
      ['SWID', d.swidPresent ? C.hidden(d.swidWellFormed ? 'present, well formed' : 'present, malformed') : C.txt('missing', null, 'bad')],
      ['Cookies changed', stamp('espnCookies')],
      ['League Password', d.leaguePasswordSet ? C.hidden('set') : C.txt('not set')], ['League Password changed', stamp('leaguePassword')],
      ['Admin Password', d.adminPasswordSet ? C.hidden('set') : C.txt('not set')], ['Admin Password changed', stamp('adminPassword')],
      ['Session secret', d.sessionSecretSet ? C.hidden('set') : C.txt('not set')],
      ['Fortune Teller', C.txt(d.fortuneTeller.enabled ? 'on' : 'off'), ], ['Fortune Teller switched', cfg.fortuneTeller && cfg.fortuneTeller.changedAt ? C.time(cfg.fortuneTeller.changedAt) : C.txt('—')],
      ['Datasets checked for', C.txt(cfg.datasetsCheckedVersion || 'not yet')]]),
    B.sub('Tools'),
    B.table([['Tool'], ['Visibility'], ['Default'], ['Changed', 'n']], TOOLS.map((t) => {
      const v = visibilityOf(cfg, t.key);
      return B.row([C.tab(t.key, t.name), C.pill(v === 'visible' ? 'ok' : v === 'admin' ? 'warn' : 'idle', visibilityLabel(v)), C.txt(visibilityLabel(t.defaultVisibility)),
        st.toolVisibility && st.toolVisibility[t.key] ? C.time(st.toolVisibility[t.key]) : C.txt('—')]);
    })),
    B.kv([['Trade weighting', C.txt(`${moved.length} of ${TRADE_ROWS.length} rows moved from the default`)], ['Weighting changed', stamp('tradeWeights')]]),
    B.sub('Home page order'),
    (() => { const o = describeTileOrder(cfg); return B.kv([['Order', C.txt(o.tiles.map((t) => t.name).join(' · '), o.custom ? 'arranged by an administrator' : 'the default')], ['Order changed', stamp('toolOrder')]]); })(),
  ];
}

async function deployBody(src) {
  const f = src.facts, bi = f.buildInfo || {}, vm = f.versionMetadata || null, iso = f.isolate || {};
  const bindings = [['CONFIG', 'KV namespace'], ['DATA', 'R2 bucket'], ['ASSETS', 'static assets'], ['COORDINATOR', 'DatasetCoordinator'], ['THROTTLE', 'LoginThrottle'],
    ['SCORE_TIMELINE', 'ScoreTimelineDO'], ['FORTUNE', 'FortuneTellerDO'], ['SITE_LOG', 'SiteLogDO'], ['CF_VERSION_METADATA', 'version metadata']];
  const present = f.bindings || {};
  const migrations = (bi.worker && bi.worker.migrations) || [];
  const tagOf = (cls) => { const m = migrations.find((x) => (x.classes || []).includes(cls)); return m ? m.tag : '—'; };
  const conn = f.viewer || {};
  return [
    B.kv([['Version', C.txt(f.build || '—', f.version ? `shown to members as ${f.version}` : null)],
      ['Deploy', vm ? C.code(String(vm.id || '').slice(0, 13) || '—', vm.tag ? `tag ${vm.tag}` : null) : C.txt('not available')],
      ['Uploaded', vm && vm.timestamp ? C.time(vm.timestamp) : '—'],
      ['Previous version', (() => { const v = src.deps.meta('version', null); return v && v.previous ? C.txt(v.previous, 'answered until this one') : '—'; })()],
      ['Worker', C.txt((bi.worker && bi.worker.name) || '—')], ['Compatibility date', C.txt((bi.worker && bi.worker.compatibilityDate) || '—')],
      ['Cron', C.code(((bi.worker && bi.worker.crons) || []).join(', ') || '—')], ['Observability', C.txt(bi.worker && bi.worker.observability ? 'on, every request' : 'off')],
      ['Built', bi.builtAt ? C.time(bi.builtAt) : C.txt('—')]]),
    B.sub('Bindings'),
    B.table([['Binding'], ['Kind'], ['Present'], ['Migration']], bindings.map(([b, kind]) => B.row([C.code(b), C.txt(kind),
      present[b] ? C.pill('ok', 'yes') : C.pill('bad', 'missing'), C.txt(/DO$|Coordinator|Throttle/.test(kind) ? tagOf(kind) : '—')], present[b] ? null : 'bad'))),
    B.sub('Client bundles'),
    (bi.bundles || []).length ? B.table([['Bundle'], ['Size', 'n'], ['Compressed', 'n'], ['Hash']], bi.bundles.map((x) => B.row([C.txt(x.name), C.bytes(x.bytes), C.bytes(x.gzip), C.code(x.hash)])))
      : B.empty('Bundle sizes are written by the build; this deployment has none recorded.'),
    B.sub('This isolate'),
    B.kv([['Started', C.time(iso.startedAt)], ['Requests it served', C.n(iso.served)], ['Config cache', C.txt('5 s per isolate')],
      ['Buffered for the log', C.n(iso.buffered)], ['Last sent to the log', C.time(iso.lastFlush)]]),
    B.sub('Your connection (shown to you, never recorded)'),
    B.kv([['Cloudflare data centre', C.txt(conn.colo || '—')], ['HTTP', C.txt(conn.httpProtocol || '—')], ['TLS', C.txt(conn.tlsVersion || '—')],
      ['Round trip', conn.rtt != null ? C.dur(conn.rtt) : '—']]),
  ];
}

async function leagueBody(src, ctx) {
  const s = await src.settings();
  const board = await src.digest('scoreboard_digest');
  if (!s) return [B.empty('League settings have not been fetched yet.')];
  const sch = s.s.scheduleSettings || {}, tr = s.s.tradeSettings || {}, dr = s.s.draftSettings || {}, sc = s.s.scoringSettings || {};
  const games = ((board && board.games) || []).slice().sort((a, b) => Date.parse(a.kickoff || 0) - Date.parse(b.kickoff || 0));
  const teams = await src.teams();
  return [
    B.kv([['League', C.txt(s.s.name || '—')], ['Teams', C.n(s.s.size || Object.keys(teams).length)],
      ['Regular season', C.txt(`${sch.matchupPeriodCount || '?'} weeks`, `now week ${s.status.currentMatchupPeriod}`)],
      ['Playoff places', C.n(sch.playoffTeamCount || 0)], ['Seeding', C.txt(seedingText(sch.playoffSeedingRule))],
      ['Divisions', C.n((sch.divisions || []).length)], ['Tie rule', C.txt(String(sc.matchupTieRule || 'none').toLowerCase().replace(/_/g, ' '))],
      ['Trade deadline', tr.deadlineDate ? C.at(tr.deadlineDate) : '—'], ['Draft', dr.date ? C.at(dr.date, `${String(dr.type || '').toLowerCase()}`) : '—'],
      ['Scoring period', C.n(s.raw.scoringPeriodId || 0, `of ${s.status.finalScoringPeriod || '?'}`)], ['NFL week', C.n((board && board.week) || 0)]]),
    B.sub(`NFL week ${(board && board.week) || '?'}`),
    games.length ? B.table([['Game'], ['Kickoff'], ['State'], ['Score', 'n']], games.map((g) => B.row([
      C.txt(`${g.away} at ${g.home}`), C.at(g.kickoff), g.final ? C.pill('idle', 'final') : g.inProgress ? C.pill('run', 'live') : C.pill('ok', 'upcoming'),
      g.started || g.final ? C.txt(`${g.awayScore ?? 0}–${g.homeScore ?? 0}`) : '—'], g.inProgress && !g.final ? 'run' : null)))
      : B.empty('The NFL scoreboard has not been stored yet.'),
  ];
}

export function seedingText(rule) {
  return ({ TOTAL_POINTS_SCORED: 'total points scored', H2H_RECORD: 'head-to-head record', INTRA_DIVISION_RECORD: 'division record', TOTAL_POINTS_AGAINST: 'total points against' })[rule] || String(rule || 'standings').toLowerCase().replace(/_/g, ' ');
}

export function securityChecks(src) {
  const f = src.facts;
  return [
    [true, 'The League Password gate sits in front of every page and data route'],
    [true, 'The Admin Password is read from a header only and checked on every admin call'],
    [true, 'The league\'s ESPN session is sent only to fantasy.espn.com hosts'],
    [true, 'Session cookie signed, HttpOnly, Secure, SameSite=Lax, 8 hours'],
    [true, 'Tool unlock cookie scoped to its own tool, 30 minutes'],
    [!f.devHooks, f.devHooks ? 'Developer hooks are present: this is a development deployment' : 'No developer hooks in this build'],
    [true, 'Public routes: /api/health and the favicon only'],
    [true, 'Visitor IP addresses, locations and devices are never recorded: an address is kept only as a keyed fingerprint, shown as an alias'],
    [true, 'Site API answers only reads (GET, HEAD, OPTIONS), ignores the sign-in cookie and serves no credential; its key opens nothing else'],
  ];
}

/**
 * Each week's timeline size. Past weeks come from the log's hourly record; the
 * current week is measured live only while a game window is open, when it grows.
 */
export async function timelineWeeks(src, season, current, live = false) {
  const cache = src.deps.meta('timelineWeeks', {}) || {};
  const out = [];
  for (let w = 1; w <= (current || 0); w++) {
    let x = cache[`${season}:${w}`];
    if (w === current && (live || !x)) {
      const r = await timelineSize(src.env, season, w);
      if (r && r.ok) x = { week: w, bytes: r.keys.rows.bytes, rows: r.keys.rows.count, events: r.keys.events.count };
    }
    if (x) out.push({ ...x, week: w });
  }
  return out;
}

export { upstream, datasetRows };
