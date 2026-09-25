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

export const CONFIG_KEY = 'config:v1';

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
function currentSeason(now = new Date()) {
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
    /* The league's own Trade Analyzer weighting, holding only the rows an
       administrator has an opinion about. Absent means "use the shipped
       defaults", which is where every league starts. */
    tradeWeights: (c.tradeWeights && typeof c.tradeWeights === 'object')
      ? c.tradeWeights : {},
    /* Fortune Teller: off until an administrator switches it on; once on, it builds
       itself as soon as a build fits and moves on each week. */
    fortuneTeller: { enabled: Boolean(c.fortuneTeller && c.fortuneTeller.enabled), changedAt: (c.fortuneTeller && c.fortuneTeller.changedAt) || null },
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

export async function loadConfig(env, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;

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
    'toolVisibility', 'datasetsCheckedVersion', 'tradeWeights', 'fortuneTeller',
  ];
  for (const field of allowed) {
    if (patch[field] === undefined) continue;
    next[field] = patch[field];
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
    fortuneTeller: { enabled: Boolean(cfg.fortuneTeller && cfg.fortuneTeller.enabled) },
    historyDiscovered: Array.isArray(cfg.historySeasons) && cfg.historySeasons.length > 0,
    leaguePasswordSet: Boolean(cfg.leaguePasswordHash),
    adminPasswordSet: Boolean(cfg.adminPasswordHash),
    sessionSecretSet: Boolean(cfg.sessionSecret),
    setupCompletedAt: cfg.setupCompletedAt,
  };
}

/** Back-compat shim for the refresh engine's readiness check. */
export function canCallEspn(cfg, needsAuth) {
  if (!cfg.leagueId) return false;
  if (needsAuth && cfg.leaguePrivate && (!cfg.espnS2 || !cfg.swid)) return false;
  return true;
}
