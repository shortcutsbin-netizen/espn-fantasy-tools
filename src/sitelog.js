/**
 * Site log: the recording half, used by the Worker and by the other Durable Objects.
 *
 * Everything here is fire-and-forget. A request is timed and counted in this
 * isolate's memory; events (a sign-in, a visit, an admin action) collect on the
 * request and are sent to the season's log object after the response, together
 * with the isolate's counters. Counters on their own are sent at most once a
 * minute. Nothing here may throw into a request, delay it, or touch R2 or KV.
 *
 * Identity is the team chosen on the browser (the eft_team cookie) and nothing
 * else: no IP address, location, device or user agent is ever read here.
 */

import { countSource, busiest } from './sources.js';
import { currentSeason, loadConfig, isSetupFinished } from './config.js';
import { brakeFrom } from './budget.js';

export const SITE_LOG_PREFIX = 'site-log-';
/** The first season a store can exist for: the release that shipped the log. */
export const FIRST_LOG_SEASON = 2026;
const FLUSH_EVERY_MS = 60 * 1000;
/** At Protect an isolate's report to the log goes once every 5 minutes (C5). */
const PROTECT_FLUSH_MS = 5 * 60 * 1000;
const MAX_SAMPLES = 16;
const MAX_BUFFERED_EVENTS = 200;

/** The season an instant belongs to, by the same rule the site uses for its config. */
export function seasonAt(ms = Date.now()) {
  return Number(currentSeason(new Date(ms)));
}

export function logStoreName(season) {
  return `${SITE_LOG_PREFIX}${season}`;
}

export function logStub(env, season = seasonAt()) {
  if (!env || !env.SITE_LOG) return null;
  try { return env.SITE_LOG.get(env.SITE_LOG.idFromName(logStoreName(season))); } catch { return null; }
}

const hourOf = (ms) => Math.floor(ms / 3600000) * 3600000;
const minuteOf = (ms) => Math.floor(ms / 60000) * 60000;

// ---------------------------------------------------------------- isolate state

// The clock does not run while a Worker's global scope is evaluated (Date.now() is 0 there),
// so an isolate's start is taken from its first request instead.
const ISO = {
  pace: null,
  paceAskedAt: 0,
  startedAt: 0,
  served: 0,
  events: [],
  hours: new Map(),
  lastFlush: 0,
  flushing: false,
  lapsed: new Map(),
  // Whether this isolate has seen the site set up (a recorded request proves it), so a flush of the counts of
  // requests that are never recorded (/api/health, the tab icon) is never sent from a site still in its wizard.
  setUp: false,
  checkingSetUp: false,
};

/** What this isolate knows about itself, for the Deployment panel. */
export function isolateFacts() {
  if (!ISO.startedAt) ISO.startedAt = Date.now();
  return { startedAt: new Date(ISO.startedAt).toISOString(), served: ISO.served,
    buffered: ISO.events.length, lastFlush: ISO.lastFlush ? new Date(ISO.lastFlush).toISOString() : null };
}

function bucket(ms = Date.now()) {
  const h = hourOf(ms);
  let b = ISO.hours.get(h);
  if (!b) {
    b = { req: {}, ops: {}, poll: {}, settings: {}, exc: 0, api: {}, all: 0 };
    ISO.hours.set(h, b);
  }
  return b;
}

/** Count an operation (an R2, KV or Durable Object call, an edge cache hit). Never throws. */
export function countOp(kind, n = 1) {
  try {
    const b = bucket();
    b.ops[kind] = (b.ops[kind] || 0) + n;
  } catch { /* counting must never matter */ }
}

/** Site API's hourly counters: answers by endpoint, too_soon by kind, holds, 304s, bad keys, downloads. Never throws. */
export function countApi(kind, key, n = 1) {
  try {
    const b = bucket();
    const g = (b.api = b.api || {})[kind] || (b.api[kind] = {});
    g[key] = (g[key] || 0) + n;
  } catch { /* counting must never matter */ }
}

/** A source's request, counted by its fingerprint in this hour (see src/sources.js). Never throws. */
export function countSourceNow(fp, fields) {
  try { if (fp) countSource(bucket(), fp, fields); } catch { /* counting must never matter */ }
}

/**
 * The day's use of each free limit, as the site log last replied with it: the pace and the load level are read
 * from this. { day, counts, rate, heardAt }, or null before the first reply.
 */
export function paceUsage() { return ISO.pace; }
function notePace(p) { if (p && p.counts) ISO.pace = { ...p, heardAt: Date.now() }; }
/** Take the day's counts as the site log replied with them (also how a test sets the level). */
export function acceptPace(p) { notePace(p); }

/** Whether this isolate has seen the site set up (a recorded request proves it): nothing is asked of the log before. */
export function knowsSetUp() { return ISO.setUp; }

/** This isolate's brake now (C5), from the counts the site log last replied with. */
export function brakeNow(now = Date.now()) { return brakeFrom(ISO.pace, now); }

/** One check-in for an isolate with no counts yet (or none for 10 minutes), at most once a minute. */
export async function paceCheckIn(env, now = Date.now()) {
  if (now - ISO.paceAskedAt < 60000) return;
  ISO.paceAskedAt = now;
  try {
    const stub = logStub(env);
    if (!stub) return;
    const r = await stub.fetch('https://site-log/pace');
    const j = await r.json().catch(() => null);
    if (j && j.pace) notePace(j.pace);
  } catch { /* the pace falls back as the plan says */ }
}

/** Routes worth a per-minute count, so "open tabs now" can be estimated. */
const POLLED = new Set(['/api/dashboard/status', '/api/live/week', '/api/data', '/api/data/draft_results',
  '/api/fortune-teller', '/apps/site-backend/api']);

/**
 * One path, as a route. Dataset keys and tool pages stay distinct; anything with
 * an identifier in it (a logo, a map, a part) is folded to its route.
 */
export function routeKey(method, path) {
  let p = path;
  if (/^\/api\/logo\//.test(p)) p = '/api/logo/:team';
  else if (/^\/api\/fortune-teller\/map\//.test(p)) p = '/api/fortune-teller/map/:team';
  else if (/^\/api\/data\/[^/]+\/./.test(p)) p = p.replace(/^(\/api\/data\/[^/]+)\/.*$/, '$1/:part');
  else if (/^\/api\/status\//.test(p)) p = '/api/status/:key';
  else if (/^\/apps\/[^/]+\/(index\.html)?$/.test(p)) p = p.replace(/index\.html$/, '');
  else if (/^\/apps\/[^/]+\/api$/.test(p)) { /* a tool's own data route stays as it is */ }
  else if (/^\/apps\/[^/]+\/.+/.test(p)) p = p.replace(/^(\/apps\/[^/]+\/).+$/, '$1*');
  else if (p === '/index.html') p = '/';
  else if (p === '/config/') p = '/config';
  else if (/^\/api\/_dev\//.test(p)) p = '/api/_dev/*';
  else if (/^\/api\/v1(\/|$)/.test(p)) p = /^\/api\/v1\/(full|scoreboard|standings|rosters|activity)(\.csv)?$/.test(p) ? p : '/api/v1/:unknown';
  else if (!/^\/(api|apps)\//.test(p) && !['/', '/config', '/favicon.svg', '/favicon.ico'].includes(p)) p = '(other)';
  if (p.length > 80) p = p.slice(0, 80);
  return `${method === 'GET' || method === 'HEAD' ? 'GET' : method} ${p}`;
}

// ---------------------------------------------------------------- the request trace

const TRACES = new WeakMap();

/** Start timing a request. */
export function beginRequest(request) {
  const trace = { t0: Date.now(), events: [], page: null, team: undefined, record: false };
  try { TRACES.set(request, trace); } catch { /* a frozen request is still served */ }
  return trace;
}

export function traceOf(request) {
  try { return TRACES.get(request) || null; } catch { return null; }
}

function readTeam(request) {
  try {
    const header = request.headers.get('cookie') || '';
    const m = /(?:^|;\s*)eft_team=([^;]*)/.exec(header);
    if (!m) return null;
    const n = Number(decodeURIComponent(m[1]));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function cookieValue(request, name) {
  try {
    const header = request.headers.get('cookie') || '';
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

/**
 * Note something that happened on this request, as a general statement.
 * `kind` is sign-in, admin, visit or operation; the team is read from the cookie.
 */
export function note(request, kind, text, { sev = 'info', page = null } = {}) {
  try {
    const trace = traceOf(request);
    const ev = { at: Date.now(), kind, sev, text: String(text).slice(0, 160), page, team: readTeam(request) };
    // A sign-in entry is kept only when a team was chosen on that browser: a request with none is anyone at all.
    if (kind === 'sign-in' && ev.team == null) return;
    if (trace) trace.events.push(ev);
    else if (ISO.events.length < MAX_BUFFERED_EVENTS) ISO.events.push(ev);
  } catch { /* recording must never matter */ }
}

/** The page this request served, for the visit and the member settings seen. */
export function markPage(request, page, name) {
  const trace = traceOf(request);
  if (trace) { trace.page = page; trace.pageName = name || page; }
}

/**
 * A request an old session made after it lapsed: a page left open keeps polling,
 * so this is kept to once per team per hour, here and again in the log object.
 */
export function noteLapsed(request) {
  try {
    if (!cookieValue(request, 'eft_team') && !cookieValue(request, 'eft_theme')) return;
    const team = readTeam(request);
    const k = `${team}:${hourOf(Date.now())}`;
    if (ISO.lapsed.has(k)) return;
    if (ISO.lapsed.size > 500) ISO.lapsed.clear();
    ISO.lapsed.set(k, true);
    note(request, 'sign-in', 'Session lapsed', { page: 'signin' });
  } catch { /* nothing */ }
}

/**
 * Finish a request: count it, collect its events, and schedule a flush when one
 * is due. `recording` is false until setup has finished.
 */
export function finishRequest(env, ctx, request, response, { recording, version, brake = 'normal' }) {
  // At Protect the isolate reports to the log once every 5 minutes, and events wait for that report (C5).
  const resting = brake === 'protect' || brake === 'limit';
  const every = resting ? PROTECT_FLUSH_MS : FLUSH_EVERY_MS;
  try {
    if (!ISO.startedAt) ISO.startedAt = Date.now();
    ISO.served += 1;
    const trace = traceOf(request);
    // Every request counts against the account's daily Worker requests the moment it arrives, recorded or not
    // (C7): the health check, the tab icon and the developer hooks included. The recorded routes below are a part.
    const at = Date.now();
    const all = bucket(at);
    all.all = (all.all || 0) + 1;
    if (!recording) {
      // An isolate that only ever serves unrecorded requests still sends its count once a minute, once it knows the
      // site is set up (one config read, held five seconds, at most once a minute).
      if (at - ISO.lastFlush >= every && !ISO.checkingSetUp) {
        ISO.checkingSetUp = true;
        const task = (async () => {
          try {
            if (!ISO.setUp) { countOp('kvr'); ISO.setUp = isSetupFinished(await loadConfig(env)); }
            if (ISO.setUp) await flush(env, { version });
            else ISO.hours.clear();   // a site in its wizard records nothing
          } catch { /* a lost count costs a minute */ } finally { ISO.checkingSetUp = false; }
        })();
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
      }
      return;
    }
    ISO.setUp = true;
    const now = at;
    const url = new URL(request.url);
    const status = response ? response.status : 500;
    const key = routeKey(request.method, url.pathname);
    const ms = trace ? now - trace.t0 : 0;
    const b = bucket(now);
    const r = b.req[key] || (b.req[key] = { n: 0, e: 0, c4: 0, ms: [], mx: 0 });
    r.n += 1;
    if (status >= 500) r.e += 1;
    else if (status >= 400) r.c4 += 1;
    if (r.ms.length < MAX_SAMPLES) r.ms.push(ms);
    else r.ms[Math.floor(Math.random() * MAX_SAMPLES)] = ms;
    if (ms > r.mx) r.mx = ms;
    if (status === 304) r.nm = (r.nm || 0) + 1;
    const plain = key.slice(key.indexOf(' ') + 1);
    if (POLLED.has(plain)) {
      const m = minuteOf(now);
      const p = b.poll[plain] || (b.poll[plain] = {});
      p[m] = (p[m] || 0) + 1;
    }
    if (trace) {
      // A page served: the sign-in page answers 401 by design, so it counts as served too.
      if (trace.page && (status === 200 || (trace.page === 'signin' && status === 401))) {
        const team = readTeam(request);
        // The sign-in page is open to anyone who asks, scanners included, so it is counted below and never stored
        // one entry a visit: only pages past the password gate are recorded as visits.
        if (trace.page !== 'signin') trace.events.push({ at: trace.t0, kind: 'visit', sev: 'info', text: `Visited ${trace.pageName}`, page: trace.page, team });
        // Member settings seen on visits: counts only, never tied to the team.
        const s = b.settings;
        const theme = cookieValue(request, 'eft_theme') === 'light' ? 'light' : 'dark';
        const motion = cookieValue(request, 'eft_motion') === 'reduce' ? 'reduce' : 'full';
        const tz = (cookieValue(request, 'eft_tz') || 'device').slice(0, 40);
        s.theme = s.theme || {}; s.theme[theme] = (s.theme[theme] || 0) + 1;
        s.motion = s.motion || {}; s.motion[motion] = (s.motion[motion] || 0) + 1;
        s.tz = s.tz || {}; s.tz[tz] = (s.tz[tz] || 0) + 1;
        s.team = s.team || {}; const tk = team == null ? 'none' : String(team); s.team[tk] = (s.team[tk] || 0) + 1;
      }
      // The source of every recorded request (the API counts its own), and page visits by the team chosen on that
      // browser: what names a likely member in High activity. Never the address, never the user agent.
      if (trace.fp) {
        const served = Boolean(trace.page && (status === 200 || (trace.page === 'signin' && status === 401)));
        countSource(b, trace.fp, { kind: trace.kind, page: served, team: served ? readTeam(request) : null });
      }
      for (const ev of trace.events) if (ISO.events.length < MAX_BUFFERED_EVENTS) ISO.events.push(ev);
      trace.events = [];
    }
    if ((ISO.events.length && !resting) || now - ISO.lastFlush >= every) {
      const task = flush(env, { version });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
    }
  } catch { /* recording must never matter */ }
}

/** An unhandled exception, counted so a burst can be reported. */
export function countException() {
  try { bucket().exc += 1; } catch { /* nothing */ }
}

/** Take everything buffered, leaving the isolate empty. Synchronous, so two flushes never send the same thing. */
function take() {
  const events = ISO.events.splice(0);
  // Each hour sends its 20 busiest sources; the rest are summed as other sources.
  const hours = [...ISO.hours.entries()].map(([hour, counts]) => ({ hour, counts: counts.src ? { ...counts, src: busiest(counts.src, 20) } : counts }));
  ISO.hours.clear();
  return { events, hours };
}

/**
 * Send what this isolate has buffered to the log object(s). Events are grouped by
 * the season they happened in, so a flush across a season change lands in both stores.
 */
export async function flush(env, { version = null, extra = null } = {}) {
  if (ISO.flushing) return;
  ISO.flushing = true;
  try {
    const { events, hours } = take();
    ISO.lastFlush = Date.now();
    if (!events.length && !hours.length && !extra) return;
    const bySeason = new Map();
    const add = (season) => {
      if (!bySeason.has(season)) bySeason.set(season, { events: [], hours: [] });
      return bySeason.get(season);
    };
    for (const e of events) add(seasonAt(e.at)).events.push(e);
    for (const h of hours) add(seasonAt(h.hour)).hours.push(h);
    if (extra) add(seasonAt()).extra = extra;
    for (const [season, body] of bySeason) {
      const stub = logStub(env, season);
      if (!stub) continue;
      // The reply carries the day's counts, which set the pace (plan: Site API, D22).
      await stub.fetch('https://site-log/ingest', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, version, isolate: isolateFacts() }),
      }).then((r) => r.json()).then((j) => notePace(j && j.pace)).catch(() => null);
    }
  } catch { /* a lost flush costs a minute of counts, never a request */ } finally {
    ISO.flushing = false;
  }
}

/**
 * Send events from somewhere other than a request: a Durable Object noticing a
 * change of state, the cron. Recording starts when setup finishes, so a site
 * still in its wizard records nothing.
 */
export async function sendEvents(env, events, { cfg = null } = {}) {
  try {
    if (!env || !env.SITE_LOG || !events || !events.length) return;
    const c = cfg || await loadConfig(env);
    if (!isSetupFinished(c)) return;
    const stub = logStub(env);
    if (!stub) return;
    const now = Date.now();
    const list = events.map((e) => ({ at: e.at || now, kind: e.kind || 'change', sev: e.sev || 'info',
      text: String(e.text || '').slice(0, 160), page: e.page || null, team: null }));
    await stub.fetch('https://site-log/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: list }),
    }).then((r) => r.body && r.body.cancel ? r.body.cancel().catch(() => {}) : null).catch(() => null);
  } catch { /* nothing */ }
}

/** A dataset coordinator's hourly tally, handed over once per hour. */
export async function sendTally(env, key, tally) {
  try {
    if (!env || !env.SITE_LOG || !tally) return;
    const stub = logStub(env, seasonAt(tally.hour));
    if (!stub) return;
    await stub.fetch('https://site-log/tally', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, tally }),
    }).then((r) => r.body && r.body.cancel ? r.body.cancel().catch(() => {}) : null).catch(() => null);
  } catch { /* nothing */ }
}

/** The cron's summary of one tick, sent with whatever the cron's isolate has buffered. */
export async function sendTick(env, tick, { version }) {
  try {
    if (!env || !env.SITE_LOG) return;
    const { events, hours } = take();
    ISO.lastFlush = Date.now();
    const stub = logStub(env, seasonAt(tick.at));
    if (!stub) return;
    await stub.fetch('https://site-log/tick', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tick, events, hours, version, isolate: isolateFacts() }),
    }).then((r) => r.body && r.body.cancel ? r.body.cancel().catch(() => {}) : null).catch(() => null);
  } catch { /* nothing */ }
}

// ---------------------------------------------------------------- counting bindings

const WRAPPED = new WeakMap();

function wrapBucket(bucketObj, add) {
  return {
    head: (...a) => { add('r2b'); return bucketObj.head(...a); },
    get: (...a) => { add('r2b'); return bucketObj.get(...a); },
    put: (...a) => { add('r2a'); return bucketObj.put(...a); },
    delete: (...a) => { add('r2a'); return bucketObj.delete(...a); },
    list: (...a) => { add('r2a'); return bucketObj.list(...a); },
    createMultipartUpload: bucketObj.createMultipartUpload ? (...a) => { add('r2a'); return bucketObj.createMultipartUpload(...a); } : undefined,
  };
}

function wrapKv(kv, add) {
  return {
    get: (...a) => { add('kvr'); return kv.get(...a); },
    getWithMetadata: kv.getWithMetadata ? (...a) => { add('kvr'); return kv.getWithMetadata(...a); } : undefined,
    put: (...a) => { add('kvw'); return kv.put(...a); },
    delete: (...a) => { add('kvw'); return kv.delete(...a); },
    list: kv.list ? (...a) => { add('kvl'); return kv.list(...a); } : undefined,
  };
}

function wrapNamespace(ns, name, add) {
  return {
    idFromName: (...a) => ns.idFromName(...a),
    idFromString: ns.idFromString ? (...a) => ns.idFromString(...a) : undefined,
    newUniqueId: ns.newUniqueId ? (...a) => ns.newUniqueId(...a) : undefined,
    get: (...a) => {
      const stub = ns.get(...a);
      return { fetch: (...f) => { add(`do:${name}`); return stub.fetch(...f); } };
    },
  };
}

// Every object binding, so the Durable Object requests gauge counts them all (the pace record's were missed).
const DO_BINDINGS = ['COORDINATOR', 'THROTTLE', 'SCORE_TIMELINE', 'FORTUNE', 'SITE_LOG', 'SOURCE_PACE', 'CLOCK'];

/**
 * The same bindings, counted. Every R2, KV and Durable Object call made through
 * the returned env is added to `sink` (by default this isolate's hour bucket).
 * The originals are untouched; wrapping is cached per env.
 */
export function meteredEnv(env, sink = null) {
  if (!env || typeof env !== 'object') return env;
  if (!sink) {
    const hit = WRAPPED.get(env);
    if (hit) return hit;
  }
  const add = sink || ((k) => countOp(k));
  const out = { ...env };
  try {
    if (env.DATA) out.DATA = wrapBucket(env.DATA, add);
    if (env.CONFIG) out.CONFIG = wrapKv(env.CONFIG, add);
    for (const b of DO_BINDINGS) if (env[b]) out[b] = wrapNamespace(env[b], b, add);
  } catch { return env; }
  if (!sink) WRAPPED.set(env, out);
  return out;
}
