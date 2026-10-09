/**
 * Site Backend: the sources a tab reads, and the small vocabulary its panels are
 * written in.
 *
 * Every source is read as stored. Nothing here refreshes a dataset, re-arms an
 * alarm or writes anywhere: the imports are reads only, and a test holds that.
 * Reads are memoised for the length of one tab request, and the two listings a
 * poll needs (data/ and status/) are shared between viewers for 15 seconds.
 */

import { DATASETS, PARAM_DATASETS, getDataset } from './datasets.js';
import { DERIVATIONS } from './derive.js';
import { loadConfig, isSetupFinished } from './config.js';
import { readEspnAuth } from './espnhealth.js';
import { getPart, listAll, DATA_PREFIX, STATUS_PREFIX, statusKey } from './store.js';
import { TOOLS, visibilityOf } from './tools.js';
import { teamLogoUrl } from './teamlogo.js';
import { PAGES, pageOf } from './readers.js';
import { FT_SUMMARY_KEY, FT_ESPN_ODDS_KEY, FT_PIPELINE_STATUS_KEY } from './fortuneteller.js';

export const LISTING_TTL_MS = 15 * 1000;
const RANK = { bad: 4, warn: 3, run: 2, ok: 1, idle: 0 };
export const DAY_MS = 86400000;

export const worst = (list) => list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
export const hourOf = (ms) => Math.floor(ms / 3600000) * 3600000;
export const utcMidnight = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
export const median = (xs) => { const a = (xs || []).filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };

// ---------------------------------------------------------------- cells and blocks

export const C = {
  time: (v, sm) => (v == null ? '—' : { k: 'time', v: typeof v === 'number' ? new Date(v).toISOString() : v, ...(sm ? { sm } : {}) }),
  at: (v, sm) => (v == null ? '—' : { k: 'at', v: typeof v === 'number' ? new Date(v).toISOString() : v, ...(sm ? { sm } : {}) }),
  bytes: (v, sm) => ({ k: 'bytes', v: Number(v) || 0, ...(sm ? { sm } : {}) }),
  pill: (s, v, sm) => ({ k: 'pill', s, v, ...(sm ? { sm } : {}) }),
  code: (v, sm) => ({ k: 'code', v: String(v), ...(sm ? { sm } : {}) }),
  tab: (tab, v, sm) => ({ k: 'tab', tab, v, ...(sm ? { sm } : {}) }),
  team: (v) => ({ k: 'team', v: v == null ? null : Number(v) }),
  dot: (s, v, sm) => ({ k: 'dot', s, v, ...(sm ? { sm } : {}) }),
  n: (v, sm) => ({ k: 'n', v: Number(v) || 0, ...(sm ? { sm } : {}) }),
  pct: (v, sm) => ({ k: 'pct', v: Number(v) || 0, ...(sm ? { sm } : {}) }),
  dur: (v, sm) => ({ k: 'dur', v: Number(v) || 0, ...(sm ? { sm } : {}) }),
  sp: (v) => ({ k: 'sp', v }),
  hidden: (sm) => ({ k: 'redact', ...(sm ? { sm } : {}) }),
  mix: (...v) => ({ k: 'mix', v }),
  txt: (v, sm, c) => ({ k: 'txt', v: String(v), ...(sm ? { sm } : {}), ...(c ? { c } : {}) }),
};

export const B = {
  kv: (items) => ({ t: 'kv', items: items.filter(Boolean) }),
  table: (cols, rows, opts = {}) => ({ t: 'table', cols, rows, ...opts }),
  row: (c, s) => ({ c, ...(s ? { s } : {}) }),
  note: (v) => ({ t: 'note', v }),
  sub: (v) => ({ t: 'sub', v }),
  empty: (v) => ({ t: 'empty', v }),
  checks: (items) => ({ t: 'checks', items }),
  list: (items) => ({ t: 'list', items }),
  bars: (items) => ({ t: 'bars', items }),
  split: (a, b) => ({ t: 'split', a, b }),
  progress: (v, s = 'run') => ({ t: 'progress', v, s }),
  btn: (v, tab, page) => ({ t: 'btn', v, tab, ...(page ? { page } : {}) }),
};

export const ttlText = (ttl) => (!ttl ? 'manual' : ttl >= 3600 ? `${ttl / 3600} h` : ttl >= 60 ? `${ttl / 60} min` : `${ttl} s`);

// ---------------------------------------------------------------- sources

/**
 * Everything a tab might read, each fetched at most once per request.
 * `deps` comes from the log object: its env, its SQL, its meter and a cache it keeps between requests.
 */
export function makeSources(deps) {
  const memo = new Map();
  const once = (k, fn) => {
    if (!memo.has(k)) memo.set(k, Promise.resolve().then(fn).catch(() => null));
    return memo.get(k);
  };
  const env = deps.env;
  const shared = (k, ttl, fn) => once(`shared:${k}`, async () => {
    const hit = deps.cache.get(k);
    if (hit && Date.now() - hit.at < ttl) return hit.v;
    const v = await fn();
    deps.cache.set(k, { at: Date.now(), v });
    return v;
  });
  const readJson = async (key) => {
    const o = await env.DATA.get(key);
    if (!o) return null;
    try { return await o.json(); } catch { return null; }
  };

  const src = {
    deps,
    env,
    now: Date.now(),
    facts: deps.facts || {},
    cfg: () => once('cfg', () => loadConfig(env)),
    espnAuth: () => once('auth', () => readEspnAuth(env)),
    /** Stored objects under data/, grouped by dataset key. */
    dataList: () => shared('data', LISTING_TTL_MS, async () => {
      const by = {};
      for (const o of await listAll(env, DATA_PREFIX)) {
        const rest = o.key.slice(DATA_PREFIX.length);
        const k = rest.split('/')[0];
        const part = rest.slice(k.length + 1).replace(/\.json$/, '');
        (by[k] = by[k] || []).push({ part, size: o.size, uploaded: o.uploaded, meta: o.meta || {} });
      }
      return by;
    }),
    /** Status documents: listed every poll, and only the changed ones re-read. */
    statuses: () => shared('status', LISTING_TTL_MS, async () => {
      const list = await listAll(env, STATUS_PREFIX);
      const prev = (deps.cache.get('statusDocs') || { v: {} }).v;
      const docs = {};
      await Promise.all(list.map(async (o) => {
        const key = o.key.slice(STATUS_PREFIX.length).replace(/\.json$/, '');
        if (prev[key] && prev[key].uploaded === o.uploaded) { docs[key] = prev[key]; return; }
        const doc = await readJson(statusKey(key));
        docs[key] = { uploaded: o.uploaded, doc };
      }));
      deps.cache.set('statusDocs', { at: Date.now(), v: docs });
      return docs;
    }),
    digest: (key) => once(`digest:${key}`, async () => {
      const o = await getPart(env, key, 'main');
      if (!o) return null;
      try { return await o.json(); } catch { return null; }
    }),
    r2json: (key) => once(`r2:${key}`, () => readJson(key)),
    r2head: (key) => once(`head:${key}`, async () => { try { return await env.DATA.head(key); } catch { return null; } }),
    ftPipeline: () => src.r2json(FT_PIPELINE_STATUS_KEY),
    ftSummary: () => src.r2json(FT_SUMMARY_KEY),
    ftOdds: () => src.r2json(FT_ESPN_ODDS_KEY),
    /** The build object's own state, through its read-only route: no watchdog, no alarm. */
    ftPeek: () => shared('ftpeek', 5000, async () => {
      if (!env.FORTUNE) return null;
      const r = await env.FORTUNE.get(env.FORTUNE.idFromName('fortune-teller')).fetch('https://ft/peek');
      return r.ok ? r.json() : null;
    }),
    /** Logo objects with their metadata (a plain list leaves custom metadata out). */
    logos: () => shared('logos', 60000, async () => {
      const out = [];
      let cursor;
      for (let i = 0; i < 5; i++) {
        const res = await env.DATA.list({ prefix: 'logos/', cursor, limit: 1000, include: ['customMetadata'] });
        for (const o of res.objects || []) out.push({ key: o.key, size: o.size, uploaded: o.uploaded instanceof Date ? o.uploaded.toISOString() : String(o.uploaded), meta: o.customMetadata || {} });
        if (!res.truncated) break;
        cursor = res.cursor;
      }
      return out;
    }),
    jobs: () => once('jobs', async () => ({ prime: await readJson('jobs/prime.json'), history: await readJson('jobs/history.json') })),
    census: () => once('census', () => deps.meta('census', null)),
    teams: () => once('teams', async () => {
      const t = await src.digest('league_teams');
      const out = {};
      for (const x of (t && t.teams) || []) out[x.id] = { name: x.name || `Team ${x.id}`, logo: teamLogoUrl(x.id, x.logo) };
      return out;
    }),
    settings: () => once('settings', async () => {
      const d = await src.digest('league_settings');
      return d ? { raw: d, s: d.settings || {}, status: d.status || {} } : null;
    }),
    /** Hour rows of the log, newest last, for the last `n` hours. */
    hours: (n = 48) => once(`hours:${n}`, () => {
      // The last three hours can still change and are read every time; the older ones are read once in ten minutes.
      const nowH = hourOf(Date.now());
      const from = nowH - (n - 1) * 3600000, live = nowH - 2 * 3600000;
      const parse = (r) => { let d = {}; try { d = JSON.parse(r.data); } catch { d = {}; } return { hour: r.hour, d }; };
      const key = `hours-old:${n}`, kept = deps.cache.get(key);
      let older;
      if (kept && kept.v.from === from && Date.now() - kept.at < 600000) older = kept.v.rows;
      else {
        older = from < live ? deps.q('SELECT hour, data FROM hours WHERE hour >= ? AND hour < ? ORDER BY hour', from, live).map(parse) : [];
        deps.cache.set(key, { at: Date.now(), v: { from, rows: older } });
      }
      return older.concat(deps.q('SELECT hour, data FROM hours WHERE hour >= ? ORDER BY hour', Math.max(from, live)).map(parse));
    }),
    meter: () => deps.meter(),
  };
  return src;
}

// ---------------------------------------------------------------- dataset states

/**
 * One dataset's state from what is stored and what its last refresh reported.
 *
 * fresh     younger than its refresh interval
 * resting   older than that only because nothing has read it since (never a fault)
 * manual    refreshed only when asked
 * kept      the last refresh failed, so a stored copy is being served
 * failing   no stored copy, and the last refresh failed
 * missing   never fetched (a re-pull is needed)
 * empty     allowed to be empty, and is
 */
export function datasetRow(d, cfg, list, statuses, now = Date.now()) {
  const stored = list[d.key] || [];
  const names = (() => { try { return new Set(d.parts(cfg).map((p) => p.part)); } catch { return null; } })();
  const expected = names ? names.size : 1;
  // Parts outside today's plan: a past week kept beside the current one, or a copy left by an older layout.
  const extraParts = names ? stored.filter((o) => !names.has(o.part)).map((o) => o.part).sort() : [];
  const bytes = stored.reduce((a, o) => a + (o.size || 0), 0);
  const newest = stored.reduce((a, o) => (!a || Date.parse(o.uploaded) > Date.parse(a) ? o.uploaded : a), null);
  const statusKeyName = d.derivedFrom || d.key;
  const st = statuses[statusKeyName] && statuses[statusKeyName].doc;
  let lastOk = null, lastAt = null, error = null;
  if (st) {
    lastAt = st.startedAt || null;
    if (d.derivedFrom) {
      const mine = [st.derived, ...(st.derivedAll || [])].filter(Boolean).find((x) => x.target === d.key);
      if (mine && mine.error) { lastOk = false; error = mine.error; } else if (st.ok === false && !stored.length) { lastOk = false; error = st.error || 'source failed'; } else lastOk = true;
    } else {
      lastOk = st.ok !== false;
      if (!lastOk) {
        const bad = (st.parts || []).find((p) => p.action === 'failed');
        error = (bad && (bad.error || (bad.status ? `HTTP ${bad.status}` : null))) || st.reason || st.error || 'refresh failed';
      }
    }
  }
  const empty = d.allowEmpty && st && (st.parts || []).length > 0 && (st.parts || []).every((p) => p.action === 'empty');
  const age = newest ? (now - Date.parse(newest)) / 1000 : Infinity;
  let state;
  if (!stored.length) state = empty ? 'empty' : lastOk === false ? 'failing' : 'missing';
  else if (lastOk === false) state = 'kept';
  else if (!d.ttl) state = 'manual';
  else state = age < d.ttl ? 'fresh' : 'resting';
  let sev;
  if (state === 'failing') sev = d.tier === 'probe' ? 'idle' : d.tier === 'core' ? 'bad' : 'warn';
  else if (state === 'kept') sev = d.tier === 'probe' ? 'idle' : (d.tier === 'core' && d.ttl && age > d.ttl * 10 ? 'bad' : 'warn');
  else if (state === 'missing') sev = d.tier === 'probe' ? 'idle' : 'warn';
  else if (state === 'fresh') sev = 'ok';
  else sev = 'idle';
  const der = [].concat(DERIVATIONS[d.derivedFrom] || []).find((x) => x.target === d.key) || null;
  const targets = [].concat(DERIVATIONS[d.key] || []).map((x) => x.target).filter(Boolean);
  return {
    key: d.key, label: d.label, group: d.group, tier: d.tier, ttl: d.ttl || 0, auth: Boolean(d.auth),
    parts: expected, stored: stored.length - extraParts.length, extraParts: extraParts.slice(0, 12), extra: extraParts.length, bytes, newest, state, sev, lastOk, lastAt, error,
    derivedFrom: d.derivedFrom || null, needs: der ? der.needs || [] : [], freshNeeds: der ? der.freshNeeds || null : null,
    current: der ? der.current || null : null, targets, allowEmpty: Boolean(d.allowEmpty),
  };
}

export async function datasetRows(src) {
  const [cfg, list, statuses] = await Promise.all([src.cfg(), src.dataList(), src.statuses()]);
  return DATASETS.map((d) => datasetRow(d, cfg, list || {}, statuses || {}, src.now));
}

/** On-demand dataset types: which ids are stored. */
export async function paramRows(src) {
  const list = (await src.dataList()) || {};
  return Object.values(PARAM_DATASETS).map((p) => {
    const stored = list[p.key] || [];
    return { key: p.key, label: p.label, ids: stored.length, bytes: stored.reduce((a, o) => a + (o.size || 0), 0),
      newest: stored.reduce((a, o) => (!a || Date.parse(o.uploaded) > Date.parse(a) ? o.uploaded : a), null) };
  });
}

/** A page's datasets: its direct reads first, then everything they are built from. */
export function upstream(keys) {
  const out = new Map();
  for (const k of keys) if (getDataset(k) && !out.has(k)) out.set(k, 'read directly');
  const queue = [...out.keys()];
  while (queue.length) {
    const k = queue.shift();
    const d = getDataset(k);
    const add = (x, via) => { if (getDataset(x) && !out.has(x)) { out.set(x, via); queue.push(x); } };
    if (d.derivedFrom) {
      add(d.derivedFrom, `source of ${k}`);
      const der = [].concat(DERIVATIONS[d.derivedFrom] || []).find((x) => x.target === k);
      for (const n of (der && der.needs) || []) add(n, `needed by ${k}`);
      if (der && der.current) add(der.current, `needed by ${k}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the log

/*
 * Queries against the log are written as SQL fragments ("AND kind = 'visit' AND page = ?").
 * The log object keeps the last eight days of events in memory, so a fragment over a
 * recent window is answered there instead of by scanning the table: a 15-second poll
 * would otherwise read the same rows hundreds of times an hour, and rows read are a
 * daily free limit shared with the rest of the site. The fragment is compiled once to
 * a predicate with SQLite's own semantics (LIKE ignores ASCII case, COUNT(DISTINCT)
 * ignores NULL); a test runs every fragment both ways and compares.
 */

const WHERE_CACHE = new Map();

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= src.length) throw new Error(`unterminated string in ${src}`);
        if (src[j] === "'") { if (src[j + 1] === "'") { v += "'"; j += 2; continue; } break; }
        v += src[j++];
      }
      out.push({ t: 'str', v }); i = j + 1; continue;
    }
    if (c === '?') { out.push({ t: 'bind' }); i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ t: c }); i++; continue; }
    const op = /^(>=|<=|!=|<>|=|<|>)/.exec(src.slice(i));
    if (op) { out.push({ t: 'op', v: op[1] }); i += op[1].length; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const w = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i));
    if (w) { const u = w[0].toUpperCase(); out.push(['AND', 'OR', 'LIKE', 'IN', 'IS', 'NOT', 'NULL'].includes(u) ? { t: u } : { t: 'id', v: w[0] }); i += w[0].length; continue; }
    throw new Error(`cannot read "${src.slice(i, i + 12)}" in ${src}`);
  }
  return out;
}

const likeRe = (pat) => new RegExp(`^${pat.split('').map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`, 'is');
const cmpVal = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) - Number(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** A where fragment as a predicate over an event row: (row, binds) => boolean. */
export function compileWhere(where) {
  const key = String(where || '');
  if (WHERE_CACHE.has(key)) return WHERE_CACHE.get(key);
  const toks = tokenize(key.replace(/^\s*AND\s+/i, ''));
  let pos = 0, bindAt = 0;
  const peek = () => toks[pos], take = (t) => { const x = toks[pos]; if (!x || (t && x.t !== t)) throw new Error(`expected ${t} in ${key}`); pos++; return x; };
  const value = () => {
    const x = take();
    if (x.t === 'str' || x.t === 'num') return () => x.v;
    if (x.t === 'NULL') return () => null;
    if (x.t === 'bind') { const k = bindAt++; return (b) => b[k]; }
    throw new Error(`expected a value in ${key}`);
  };
  const term = () => {
    if (peek() && peek().t === '(') { take('('); const e = orExpr(); take(')'); return e; }
    const col = take('id').v;
    const get = (r) => r[col];
    const x = take();
    if (x.t === 'op') {
      const v = value();
      const op = x.v;
      return (r, b) => {
        const a = get(r), w = v(b);
        if (a == null || w == null) return false;
        const c = cmpVal(a, w);
        return op === '=' ? c === 0 : op === '!=' || op === '<>' ? c !== 0 : op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c < 0;
      };
    }
    if (x.t === 'LIKE') { const v = value(); return (r, b) => { const a = get(r); const w = v(b); return a != null && w != null && likeRe(String(w)).test(String(a)); }; }
    if (x.t === 'IS') {
      const neg = peek() && peek().t === 'NOT' ? (take('NOT'), true) : false;
      const v = value();
      return (r, b) => { const a = get(r), w = v(b); const same = a == null || w == null ? a == null && w == null : cmpVal(a, w) === 0; return neg ? !same : same; };
    }
    if (x.t === 'IN') {
      take('(');
      const vs = [value()];
      while (peek() && peek().t === ',') { take(','); vs.push(value()); }
      take(')');
      return (r, b) => { const a = get(r); return a != null && vs.some((v) => { const w = v(b); return w != null && cmpVal(a, w) === 0; }); };
    }
    throw new Error(`unsupported operator in ${key}`);
  };
  const andExpr = () => { const parts = [term()]; while (peek() && peek().t === 'AND') { take('AND'); parts.push(term()); } return (r, b) => parts.every((p) => p(r, b)); };
  const orExpr = () => { const parts = [andExpr()]; while (peek() && peek().t === 'OR') { take('OR'); parts.push(andExpr()); } return (r, b) => parts.some((p) => p(r, b)); };
  const fn = toks.length ? orExpr() : () => true;
  if (pos !== toks.length) throw new Error(`could not read all of ${key}`);
  WHERE_CACHE.set(key, fn);
  return fn;
}

/** The log object's in-memory window, when it covers `since`. */
function recentFor(src, since) {
  const r = src.deps.recent ? src.deps.recent() : null;
  // A window cut at its row limit answers only for the time it covers; older asks go to the table.
  return r && since >= r.from && (r.complete || (r.rows.length > 0 && since >= r.rows[0].at)) ? r : null;
}

const COLS = 'id, at, kind, sev, text, page, team, n';

export function eventsSince(src, sinceMs, where = '', ...binds) {
  const r = recentFor(src, sinceMs);
  if (r) {
    const f = compileWhere(where), out = [];
    for (let i = r.rows.length - 1; i >= 0 && out.length < 2000; i--) { const e = r.rows[i]; if (e.at >= sinceMs && f(e, binds)) out.push(e); }
    return out;
  }
  return src.deps.q(`SELECT ${COLS} FROM events WHERE at >= ? ${where} ORDER BY id DESC LIMIT 2000`, sinceMs, ...binds);
}

export function countEvents(src, sinceMs, where = '', ...binds) {
  const r = recentFor(src, sinceMs);
  if (r) {
    const f = compileWhere(where); let n = 0; const teams = new Set();
    for (const e of r.rows) if (e.at >= sinceMs && f(e, binds)) { n += e.n || 1; if (e.team != null) teams.add(e.team); }
    return { n, teams: teams.size };
  }
  const row = src.deps.q(`SELECT COALESCE(SUM(n), 0) AS n, COUNT(DISTINCT team) AS teams FROM events WHERE at >= ? ${where}`, sinceMs, ...binds)[0];
  return { n: row ? row.n : 0, teams: row ? row.teams : 0 };
}

/** Totals grouped by one column since a time: Map value -> { n, teams }. */
export function groupEvents(src, sinceMs, where, field, ...binds) {
  const out = new Map();
  const r = recentFor(src, sinceMs);
  if (r) {
    const f = compileWhere(where); const sets = new Map();
    for (const e of r.rows) {
      if (e.at < sinceMs || !f(e, binds)) continue;
      const k = e[field];
      const g = out.get(k) || { n: 0, teams: 0 };
      g.n += e.n || 1; out.set(k, g);
      if (e.team != null) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(e.team); }
    }
    for (const [k, g] of out) g.teams = sets.has(k) ? sets.get(k).size : 0;
    return out;
  }
  for (const row of src.deps.q(`SELECT ${field} AS k, SUM(n) AS n, COUNT(DISTINCT team) AS teams FROM events WHERE at >= ? ${where} GROUP BY ${field}`, sinceMs, ...binds)) {
    out.set(row.k, { n: row.n, teams: row.teams });
  }
  return out;
}

/**
 * The newest `limit` events matching a fragment. The in-memory window answers first;
 * anything older is read once and kept for an hour, since older entries never change.
 */
export function latestEvents(src, where = '', limit = 1, ...binds) {
  const r = src.deps.recent ? src.deps.recent() : null;
  const out = [];
  if (r) {
    const f = compileWhere(where);
    for (let i = r.rows.length - 1; i >= 0 && out.length < limit; i--) if (f(r.rows[i], binds)) out.push(r.rows[i]);
    if (out.length >= limit || r.complete) return out;
    const floor = r.rows.length ? r.rows[0].id : Number.MAX_SAFE_INTEGER;
    const key = `older:${where}:${JSON.stringify(binds)}:${limit}:${floor}`;
    const hit = src.deps.cache.get(key);
    if (hit && Date.now() - hit.at < 3600000) return out.concat(hit.v).slice(0, limit);
    const older = src.deps.q(`SELECT ${COLS} FROM events WHERE id < ? ${where} ORDER BY id DESC LIMIT ?`, floor, ...binds, limit - out.length);
    src.deps.cache.set(key, { at: Date.now(), v: older });
    return out.concat(older);
  }
  return src.deps.q(`SELECT ${COLS} FROM events WHERE 1 = 1 ${where} ORDER BY id DESC LIMIT ?`, ...binds, limit);
}

/** Sum one hour-level field over a set of hour rows. */
/**
 * Every request the site served in these hours: the count of all of them where it exists (from C7), and the
 * recorded ones for an hour before it did. The recorded routes are a part of the whole; the health check, the tab
 * icon and the developer hooks are served but never recorded.
 */
export function servedReq(rows) {
  let n = 0;
  for (const { d } of rows) {
    let rec = 0;
    for (const r of Object.values(d.req || {})) rec += r.n || 0;
    n += Math.max(d.all || 0, rec);
  }
  return n;
}

export function sumReq(rows, pred = () => true) {
  let n = 0, e = 0, c4 = 0, nm = 0; const ms = []; let mx = 0;
  for (const { d } of rows) {
    for (const [k, r] of Object.entries(d.req || {})) {
      if (!pred(k)) continue;
      n += r.n || 0; e += r.e || 0; c4 += r.c4 || 0; nm += r.nm || 0;
      for (const v of r.ms || []) ms.push(v);
      if ((r.mx || 0) > mx) mx = r.mx;
    }
  }
  return { n, e, c4, nm, med: median(ms), mx };
}

export function ticksOf(rows) {
  const out = {};
  for (const { d } of rows) for (const [m, t] of Object.entries(d.ticks || {})) out[m] = t;
  return out;
}

// ---------------------------------------------------------------- tools, pages, visibility

export function visibilityLabel(v) {
  return v === 'admin' ? 'admin-only' : v === 'hidden' ? 'hidden' : 'visible';
}

export function pageVisibility(cfg, page) {
  if (!page.tool) return 'always on';
  return visibilityLabel(visibilityOf(cfg, page.tool));
}

export { PAGES, pageOf, TOOLS, isSetupFinished };
