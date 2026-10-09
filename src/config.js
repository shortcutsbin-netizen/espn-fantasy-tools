/**
 * KV-backed configuration.
 *
 * KV holds small, rarely-written config. R2 holds dataset blobs. Never the reverse.
 *
 * Two efficiency properties matter here, because Workers KV on the Free plan
 * allows only 100,000 key reads per day:
 *
 *  1. All config lives under ONE key, not one key per field. Reading seven keys
 *     per API request would exhaust the daily allowance during a single busy
 *     Sunday and start erroring.
 *  2. A short-lived in-isolate cache absorbs repeat reads. Worker isolates
 *     persist across requests, so a 60s cache turns thousands of KV reads into
 *     a handful without ever serving meaningfully stale config.
 *
 * ESPN cookies and password hashes are read server-side only and are never
 * included in any response body. `describeConfig()` exists so diagnostics can
 * report on presence without echoing secret values.
 */

import { normaliseSiteApi, keyState } from './apikey.js';
import { SESSION_STOPS, sessionHoursOf } from './auth.js';

export const CONFIG_KEY = 'config:v1';

function describeSiteApi(raw) {
  const sa = normaliseSiteApi(raw);
  const st = keyState(sa);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return { on: sa.on, started: Boolean(sa.gen), startedAt: sa.startedAt, changesAt: iso(st.changesAt), interval: sa.interval,
    inAddress: sa.inAddress, graceUntil: st.prev ? iso(st.prev.stopsAt) : null, replacedAt: sa.replacedAt };
}

// Legacy per-field keys, read once to migrate an existing deployment.
const LEGACY_KEYS = {
  leagueId: 'config:league_id',
  espnS2: 'config:espn_s2',
  swid: 'config:swid',
  season: 'config:season',
  leaguePrivate: 'config:league_private',
  historySeasons: 'config:history_seasons',
};

/**
 * The season to assume when the config carries none.
 *
 * Derived rather than pinned, per the platform rule. A literal here is
 * invisible until the year turns: a fork deployed in a later season with no
 * season stored would quietly fetch the wrong year's league and look broken for
 * reasons nobody could see in the config. The NFL year rolls over with the
 * season itself, not with the calendar, so anything from August onwards belongs
 * to the year it started in.
 */
/** An address on workers.dev, as an origin (https://name.account.workers.dev), or null for anything else. */
export function workersOriginOf(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(u.hostname) ? u.origin : null;
  } catch { return null; }
}

export function currentSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  return String(now.getUTCMonth() >= 7 ? year : year - 1);
}

/**
 * How long an isolate may trust its cached config.
 *
 * The cache exists to keep a KV read off every request, and at five seconds it
 * still does that for any realistic burst. Sixty seconds did not, in the way
 * that matters: `invalidateConfigCache()` only clears the isolate that handled
 * the write, so every *other* isolate carried on serving the old config for up
 * to a minute afterwards. That is invisible almost always and then suddenly is
 * not — a password change appearing not to take, or setup being refused
 * outright because the isolate answering still believed the site was already
 * configured. Bounding the window is the cheap fix; the alternative is a
 * cross-isolate invalidation channel for data that changes a handful of times
 * in a deployment's life.
 */
const CACHE_MS = 5000;

let cache = null;
let cacheAt = 0;

/** Drop the in-isolate cache. Called after every write so a change is immediate. */
export function invalidateConfigCache() {
  cache = null;
  cacheAt = 0;
}

function normalise(raw) {
  const c = raw || {};
  return {
    leagueId: c.leagueId || null,
    espnS2: c.espnS2 || null,
    swid: c.swid || null,
    season: c.season || currentSeason(),
    leaguePrivate: c.leaguePrivate === undefined ? true : Boolean(c.leaguePrivate),
    historySeasons: Array.isArray(c.historySeasons) && c.historySeasons.length ? c.historySeasons : null,
    leaguePasswordHash: c.leaguePasswordHash || null,
    adminPasswordHash: c.adminPasswordHash || null,
    sessionSecret: c.sessionSecret || null,
    setupCompletedAt: c.setupCompletedAt || null,
    toolVisibility: c.toolVisibility || {},
    /* The home page's tile order, when an administrator has arranged it; null means
       the default order. Made whole against the registry when read (tools.js). */
    /* How long a sign-in lasts: one of SESSION_STOPS (hours, or 'infinite'); null means the default. */
    sessionHours: SESSION_STOPS.includes(c.sessionHours) ? c.sessionHours : null,
    /* Seconds since the epoch: sign-ins made before this moment no longer count (set when the League Password changes). */
    sessionsFrom: Number.isFinite(c.sessionsFrom) ? c.sessionsFrom : null,
    toolOrder: Array.isArray(c.toolOrder) && c.toolOrder.length ? c.toolOrder.filter((k) => typeof k === 'string').slice(0, 40) : null,
    /* The league's own Trade Analyzer weighting, holding only the rows an
       administrator has an opinion about. Absent means "use the shipped
       defaults", which is where every league starts. */
    tradeWeights: (c.tradeWeights && typeof c.tradeWeights === 'object')
      ? c.tradeWeights : {},
    /* The site's own workers.dev address, noted the first time the site is asked for there. Site API's guides
       are written against it wherever the page is opened, so a site that also answers at a custom domain hands
       out the same addresses as one that does not. Null until seen. */
    workersOrigin: workersOriginOf(c.workersOrigin),
    /* Fortune Teller: off until an administrator switches it on; once on, it builds
       itself as soon as a build fits and moves on each week. */
    fortuneTeller: { enabled: Boolean(c.fortuneTeller && c.fortuneTeller.enabled), changedAt: (c.fortuneTeller && c.fortuneTeller.changedAt) || null },
    /* Site API: the switch, the key's generation and when it started, the replacement interval, the previous
       generation and when its grace ends, and whether the key may travel in the address. Never a key. */
    siteApi: normaliseSiteApi(c.siteApi),
    /* When each sensitive setting last changed, for Site Backend: a timestamp per
       setting, never a value. Written by the handlers that change them. */
    stamps: (c.stamps && typeof c.stamps === 'object') ? c.stamps : {},
    // The build this site last confirmed its datasets against. Internal
    // bookkeeping for the post-update re-pull banner: deliberately absent from
    // describeConfig, because it describes the deployment rather than the league.
    datasetsCheckedVersion: c.datasetsCheckedVersion || null,
  };
}

/** True once the site has both passwords set — i.e. the wizard has been run. */
export function isConfigured(cfg) {
  return Boolean(cfg.leaguePasswordHash && cfg.adminPasswordHash && cfg.sessionSecret);
}

/**
 * True once the wizard has run all the way through. Distinct from isConfigured:
 * passwords can be set while the league connection still isn't, and a browser
 * reloading mid-wizard needs to land back in the wizard, not on an empty site.
 */
export function isSetupFinished(cfg) {
  return isConfigured(cfg) && Boolean(cfg.leagueId) && Boolean(cfg.setupCompletedAt);
}

/** True once ESPN can actually be called for this league. */
export function isEspnReady(cfg) {
  if (!cfg.leagueId) return false;
  if (cfg.leaguePrivate && (!cfg.espnS2 || !cfg.swid)) return false;
  return true;
}

async function migrateLegacy(env) {
  const entries = await Promise.all(
    Object.entries(LEGACY_KEYS).map(async ([field, key]) => [field, await env.CONFIG.get(key)])
  );
  const found = entries.filter(([, v]) => v !== null && v !== undefined);
  if (!found.length) return null;

  const out = {};
  for (const [field, value] of found) {
    if (field === 'leaguePrivate') out[field] = value === 'true';
    else if (field === 'historySeasons') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) out[field] = parsed;
      } catch { /* ignore a malformed legacy value */ }
    } else out[field] = value;
  }
  await env.CONFIG.put(CONFIG_KEY, JSON.stringify(out));
  return out;
}

/**
 * How long this isolate holds the settings: 5 seconds normally; longer while the brake is on (5 minutes at Economy,
 * 30 at Protect), because every hold is a KV read saved; and 5 minutes inside the backend clock, which reads KV
 * barely at all (C5). An admin save still hands its new values over explicitly, as it always has.
 */
export function configHoldMs(env) {
  if (env && Number(env.CONFIG_HOLD_MS) > 0) return Number(env.CONFIG_HOLD_MS);
  const brake = env && env.BRAKE;
  return brake === 'protect' || brake === 'limit' ? 30 * 60 * 1000 : brake === 'economy' ? 5 * 60 * 1000 : CACHE_MS;
}

export async function loadConfig(env, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < configHoldMs(env)) return cache;

  let raw = null;
  const stored = await env.CONFIG.get(CONFIG_KEY);
  if (stored) {
    try {
      raw = JSON.parse(stored);
    } catch {
      raw = null;
    }
  }
  if (!raw) raw = await migrateLegacy(env);

  cache = normalise(raw);
  cacheAt = Date.now();
  return cache;
}

/** Merge a patch into stored config. Only known fields are persisted. */
export async function saveConfig(env, patch) {
  const current = await loadConfig(env, { fresh: true });
  const next = { ...current };
  const allowed = [
    'leagueId', 'espnS2', 'swid', 'season', 'leaguePrivate', 'historySeasons',
    'leaguePasswordHash', 'adminPasswordHash', 'sessionSecret', 'setupCompletedAt',
    'toolVisibility', 'toolOrder', 'sessionHours', 'sessionsFrom', 'datasetsCheckedVersion', 'tradeWeights', 'fortuneTeller', 'stamps', 'siteApi',
    'workersOrigin',
  ];
  for (const field of allowed) {
    if (patch[field] === undefined) continue;
    next[field] = patch[field];
  }
  /* Stamps merge rather than replace, so a handler records the one setting it
     changed without knowing about the others. */
  if (patch.stamps && typeof patch.stamps === 'object') {
    const was = current.stamps || {};
    next.stamps = { ...was, ...patch.stamps,
      toolVisibility: { ...(was.toolVisibility || {}), ...(patch.stamps.toolVisibility || {}) } };
  }
  await env.CONFIG.put(CONFIG_KEY, JSON.stringify(next));
  invalidateConfigCache();
  return loadConfig(env, { fresh: true });
}

/** Config summary safe to render — never contains a secret value. */
export function describeConfig(cfg) {
  return {
    leagueId: cfg.leagueId || null,
    season: cfg.season,
    leaguePrivate: cfg.leaguePrivate,
    configured: isConfigured(cfg),
    espnReady: isEspnReady(cfg),
    espnS2Present: Boolean(cfg.espnS2),
    espnS2Length: cfg.espnS2 ? cfg.espnS2.length : 0,
    swidPresent: Boolean(cfg.swid),
    swidWellFormed: cfg.swid ? /^\{[0-9A-Fa-f-]{36}\}$/.test(cfg.swid) : false,
    historySeasons: cfg.historySeasons,
    /* Only the rows the administrator actually moved. Storing all twenty-eight
       would freeze this league's weighting against the shipped defaults, so a
       later change to a default nobody had opinions about would never reach
       them. An empty object means "use the defaults", which is also what every
       new league starts with. */
    tradeWeights: cfg.tradeWeights || {},
    toolOrder: cfg.toolOrder || null,
    sessionHours: sessionHoursOf(cfg),
    fortuneTeller: { enabled: Boolean(cfg.fortuneTeller && cfg.fortuneTeller.enabled) },
    // The switch, dates, interval and address setting; never anything that could rebuild a key.
    siteApi: describeSiteApi(cfg.siteApi),
    historyDiscovered: Array.isArray(cfg.historySeasons) && cfg.historySeasons.length > 0,
    leaguePasswordSet: Boolean(cfg.leaguePasswordHash),
    adminPasswordSet: Boolean(cfg.adminPasswordHash),
    sessionSecretSet: Boolean(cfg.sessionSecret),
    setupCompletedAt: cfg.setupCompletedAt,
    // Times only; which setting changed when, never what it changed to.
    stamps: cfg.stamps || {},
  };
}

/** Back-compat shim for the refresh engine's readiness check. */
export function canCallEspn(cfg, needsAuth) {
  if (!cfg.leagueId) return false;
  if (needsAuth && cfg.leaguePrivate && (!cfg.espnS2 || !cfg.swid)) return false;
  return true;
}
