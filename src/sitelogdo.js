/**
 * SiteLogDO: the site's activity log, one SQLite-backed object per season.
 *
 * Four tables: events (who did what, and changes of state), hours (counters per
 * hour: traffic, calls, member settings, cron ticks, dataset tallies), reports
 * (one status line per subsystem per hour) and meta (schema, the daily budget
 * meter, the state that change detection compares against, the storage census).
 *
 * It writes only to its own storage. Everything it reads elsewhere (R2, KV,
 * other objects) is read as stored, through src/sitebackend.js, which imports no
 * write or refresh function.
 *
 * Budget: 10% of the Durable Object free allowance per UTC day, 10,000 requests
 * and 10,000 rows written, metered here. At the ceiling, counters, ticks and
 * status reports pause until 00:00 UTC; sign-ins, admin actions, visits,
 * operations and changes of state are still recorded.
 *
 * Rows read are a daily free limit too, shared with the whole account, so the
 * last eight days of events are kept in memory and a poll's counts are answered
 * there rather than by scanning the table each time.
 */

import { assembleTab, hourlyReports, runCensus, datasetDetail } from './sitebackend.js';
import { LOG_BUDGET_REF, GUARD_BYTES, EVENTS_PER_DAY, WINDOW_ROWS, READ_TIERS } from './sblimits.js';
import { meteredEnv } from './sitelog.js';
import { BYTE_BUDGET } from './scoretimeline.js';
import { levelFrom, BRAKE_OF, BRAKE_WORDS, LIMIT_WORDS } from './budget.js';
import { likelyTeams } from './sources.js';
const LEVEL_RANK = { quiet: 0, normal: 1, busy: 2, verybusy: 3, resting: 4 };

export const LOG_BUDGET = LOG_BUDGET_REF;
export { GUARD_BYTES };
const CLIENT_EVENTS_PER_MINUTE = 60;
const CENSUS_EVERY_MS = 10 * 60 * 1000;
const MAX_MS_SAMPLES = 64;
const RECENT_MS = 8 * 86400000;
const METER_SAVE_MS = 5 * 60 * 1000;
const SCHEMA = 1;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hourOf = (ms) => Math.floor(ms / 3600000) * 3600000;
const minuteOf = (ms) => Math.floor(ms / 60000) * 60000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function pushSample(list, v) {
  if (list.length < MAX_MS_SAMPLES) list.push(v);
  else list[Math.floor(Math.random() * MAX_MS_SAMPLES)] = v;
}

/** Add one hour's counts into another, in place. */
export function mergeCounts(into, add) {
  if (!add) return into;
  for (const [k, r] of Object.entries(add.req || {})) {
    const t = (into.req = into.req || {})[k] || (into.req[k] = { n: 0, e: 0, c4: 0, ms: [], mx: 0 });
    t.n += r.n || 0; t.e += r.e || 0; t.c4 += r.c4 || 0;
    if (r.nm) t.nm = (t.nm || 0) + r.nm;
    for (const v of r.ms || []) pushSample(t.ms, v);
    if ((r.mx || 0) > t.mx) t.mx = r.mx;
  }
  for (const [k, v] of Object.entries(add.ops || {})) (into.ops = into.ops || {})[k] = (into.ops[k] || 0) + v;
  for (const [route, mins] of Object.entries(add.poll || {})) {
    const p = (into.poll = into.poll || {})[route] || (into.poll[route] = {});
    for (const [m, n] of Object.entries(mins)) p[m] = (p[m] || 0) + n;
  }
  for (const [group, vals] of Object.entries(add.settings || {})) {
    const g = (into.settings = into.settings || {})[group] || (into.settings[group] = {});
    for (const [k, n] of Object.entries(vals)) g[k] = (g[k] || 0) + n;
  }
  into.exc = (into.exc || 0) + (add.exc || 0);
  if (add.all) into.all = (into.all || 0) + add.all;
  for (const [kind, vals] of Object.entries(add.api || {})) {
    const g = (into.api = into.api || {})[kind] || (into.api[kind] = {});
    for (const [k, n] of Object.entries(vals || {})) g[k] = (g[k] || 0) + n;
  }
  for (const [id, s] of Object.entries(add.src || {})) mergeSource(into, id, s);
  return into;
}

const SOURCES_PER_HOUR = 200;
/** One source's hour merged in; past 200 sources an hour, the rest are summed as other sources. */
export function mergeSource(into, id, s) {
  const src = (into.src = into.src || {});
  let t = src[id];
  if (!t) {
    if (id !== 'other' && Object.keys(src).filter((k) => k !== 'other').length >= SOURCES_PER_HOUR) {
      const o = src.other || (src.other = { f: 'other', n: 0, srcs: 0 });
      o.n += s.n || 0; o.srcs += s.srcs || 1;
      return;
    }
    t = src[id] = { f: s.f, n: 0 };
  }
  t.n += s.n || 0;
  if (s.srcs) t.srcs = (t.srcs || 0) + s.srcs;
  if (s.k) t.k = s.k;
  if (s.ak) t.ak = s.ak;
  for (const f of ['api', 'pg', 'hd', 'af', 'bp']) if (s[f]) t[f] = (t[f] || 0) + s[f];
  for (const f of ['ep', 'key', 'nm', 'rf', 'nr']) {
    if (!s[f]) continue;
    const g = t[f] || (t[f] = {});
    for (const [k, n] of Object.entries(s[f])) if (g[k] || Object.keys(g).length < 12) g[k] = (g[k] || 0) + n;
  }
}

/** One hour's use of the limits the pace watches, from its counts. */
export function paceCountsOf(d) {
  const out = { worker: 0, doReq: 0, rowsW: 0, kvR: 0, kvW: 0 };
  // Every request the site served (counted since C7), or, for an hour before that, the recorded ones; and every cron run.
  let rec = 0;
  for (const r of Object.values(d.req || {})) rec += r.n || 0;
  out.worker = Math.max(d.all || 0, rec) + Object.keys(d.ticks || {}).length;
  for (const bag of [d.ops || {}, d.dsOps || {}]) {
    for (const [k, v] of Object.entries(bag)) {
      if (k.startsWith('do:') && k !== 'do:SITE_LOG') out.doReq += v;
      else if (k === 'kvr') out.kvR += v;
      else if (k === 'kvw') out.kvW += v;
    }
  }
  for (const t of Object.values(d.ds || {})) out.rowsW += t.req || 0;
  return out;
}

/** A dataset coordinator's tally merged into the hour. */
export function mergeTally(into, key, t) {
  const ds = (into.ds = into.ds || {});
  const d = ds[key] || (ds[key] = { req: 0, sweeps: 0, coalesced: 0, fetched: 0, failed: 0, bytes: 0, ms: 0 });
  for (const f of ['req', 'sweeps', 'coalesced', 'fetched', 'failed', 'bytes', 'ms']) d[f] += t[f] || 0;
  for (const [host, h] of Object.entries(t.hosts || {})) {
    const hs = (into.hosts = into.hosts || {});
    const x = hs[host] || (hs[host] = { n: 0, f: 0, ms: [], fb: 0, last: null });
    x.n += h.n || 0; x.f += h.f || 0; x.fb += h.fb || 0;
    if (h.last && (!x.last || h.last.at >= x.last.at)) x.last = h.last;
    for (const v of h.ms || []) pushSample(x.ms, v);
  }
  for (const [k, n] of Object.entries(t.ops || {})) (into.dsOps = into.dsOps || {})[k] = (into.dsOps[k] || 0) + n;
  return into;
}

/** What a tick stores per minute: the jobs' summaries without any bulky results. */
function tickSummary(jobs) {
  const out = {};
  for (const [k, v] of Object.entries(jobs || {})) {
    if (!v || typeof v !== 'object') { out[k] = v; continue; }
    const { result, ...rest } = v;
    void result;
    out[k] = rest;
  }
  return out;
}

export class SiteLogDO {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.rawEnv = env;
    this.opsPending = {};
    // Reads this object makes elsewhere (R2 lists, KV, other objects) count toward the site's usage like any other.
    this.env = meteredEnv(env, (k) => { this.opsPending[k] = (this.opsPending[k] || 0) + 1; });
    this.meter = null;
    this.meterSavedAt = 0;
    this.client = { minute: 0, n: 0 };
    this.cache = new Map();
    this.ready = false;
    this.recentWin = null;
    this.kinds = null;
    this.kindsDirty = false;
    this.lastTick = undefined;
    this.devTier = null;
  }

  // ---------------------------------------------------------------- storage

  run(query, ...binds) {
    const cur = this.sql.exec(query, ...binds);
    const rows = cur.toArray();
    this.count(cur.rowsWritten || 0, cur.rowsRead || 0);
    return rows;
  }

  one(query, ...binds) { return this.run(query, ...binds)[0] || null; }

  count(written, read) {
    const m = this.meterNow();
    m.rows += written; m.read += read;
  }

  hasTables() {
    try { return Boolean(this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").toArray()[0]); } catch { return false; }
  }

  init() {
    if (this.ready) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
        sev TEXT, text TEXT, page TEXT, team INTEGER, n INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE INDEX IF NOT EXISTS events_page ON events(page, id);
      CREATE TABLE IF NOT EXISTS hours (hour INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, hour INTEGER NOT NULL, sub TEXT, sev TEXT, text TEXT);
      CREATE INDEX IF NOT EXISTS reports_hour ON reports(hour);`);
    const m = this.sql.exec("SELECT v FROM meta WHERE k = 'meter'").toArray()[0];
    try { this.meter = m ? JSON.parse(m.v) : null; } catch { this.meter = null; }
    if (!this.sql.exec("SELECT v FROM meta WHERE k = 'schema'").toArray()[0]) {
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(SCHEMA));
    }
    this.ready = true;
  }

  getMeta(k, fallback = null) {
    const r = this.one('SELECT v FROM meta WHERE k = ?', k);
    if (!r) return fallback;
    try { return JSON.parse(r.v); } catch { return fallback; }
  }

  setMeta(k, v) { this.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }

  meterNow(now = Date.now()) {
    const day = dayOf(now);
    if (!this.meter || this.meter.day !== day) {
      const prev = this.meter;
      this.meter = { day, req: 0, rows: 0, read: 0, reached: false };
      this.meterSavedAt = 0;
      if (prev && prev.day && this.ready) this.pushDaily(prev);
    }
    return this.meter;
  }

  /** Yesterday's meter joins a short history for the usage panels. */
  pushDaily(prev) {
    try {
      const hist = (this.getMeta('daily', []) || []).filter((x) => x.day !== prev.day);
      hist.push({ day: prev.day, req: prev.req, rows: prev.rows, read: prev.read });
      this.setMeta('daily', hist.slice(-40));
    } catch { /* a missing history point is harmless */ }
  }

  paused() {
    const m = this.meterNow();
    return m.req >= LOG_BUDGET.requests || m.rows >= LOG_BUDGET.rows;
  }

  /**
   * Rows read are shared by every object on the account (5 million a day, free plan), so the log keeps to a tenth
   * of them. Past it the heavy reads stop (the window, the totals, the panels' queries) and writes carry on.
   */
  readsPaused() {
    return this.readTier() >= 3;
  }

  /** 0 below the first tier, 1 and 2 as the read share fills, 3 once it is spent. */
  readTier() {
    // Dev only (a site with a developer token): a tier held for a while, so each can be looked at on the page.
    if (this.devTier && Date.now() < this.devTier.until) return this.devTier.n;
    const f = this.meterNow().read / LOG_BUDGET.read;
    return f >= 1 ? 3 : f >= READ_TIERS[1] ? 2 : f >= READ_TIERS[0] ? 1 : 0;
  }

  /** The error a read throws when its tier has stopped it; a panel catches it and rests, the rest carry on. */
  restError(tier) {
    const e = new Error('resting to protect the day\'s free reads');
    e.logPaused = true; e.tier = tier; e.pct = Math.round((this.meterNow().read / LOG_BUDGET.read) * 100);
    return e;
  }

  /**
   * The meter and the per-kind totals are saved together, at most every five
   * minutes: an object evicted in between forgets a few minutes of its own count,
   * which costs far less than a row written on every request.
   */
  saveMeter(force = false) {
    const m = this.meterNow();
    const now = Date.now();
    if (!force && !this.kindsDirty && now - this.meterSavedAt < METER_SAVE_MS) return;
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('meter', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(m));
    m.rows += 1;
    if (this.kindsDirty && this.kinds) {
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('kinds', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(this.kinds));
      m.rows += 1;
      this.kindsDirty = false;
    }
    this.meterSavedAt = now;
  }

  transaction(fn) {
    const t = this.state.storage.transactionSync;
    if (typeof t === 'function') return t.call(this.state.storage, fn);
    return fn();
  }

  size() {
    try { return Number(this.sql.databaseSize) || 0; } catch { return 0; }
  }

  // ---------------------------------------------------------------- the in-memory window

  /**
   * The last eight days of events, oldest first; loaded when a panel first asks for them, then kept in step with
   * every insert. Recording never loads it: a restarted object that only records reads nothing.
   */
  recent() {
    const from = Date.now() - RECENT_MS;
    if (!this.recentWin) {
      // From the first tier on, a cold window is not loaded: empty and incomplete, nothing kept, so the next call tries again.
      if (this.readTier() >= 1) return { from, rows: [], complete: false };
      // The newest rows only: one load can never read more than WINDOW_ROWS, whatever the table holds.
      const rows = this.run('SELECT * FROM (SELECT id, at, kind, sev, text, page, team, n FROM events WHERE at >= ? ORDER BY id DESC LIMIT ?) ORDER BY id', from, WINDOW_ROWS);
      const oldest = this.one('SELECT MIN(at) AS at FROM events');
      this.recentWin = { from, rows, complete: rows.length < WINDOW_ROWS && (!oldest || oldest.at == null || oldest.at >= from) };
    } else if (from - this.recentWin.from > 3600000) {
      const rows = this.recentWin.rows;
      let i = 0;
      while (i < rows.length && rows[i].at < from) i++;
      this.recentWin = { from, rows: i ? rows.slice(i) : rows, complete: this.recentWin.complete && i === 0 };
    }
    return this.recentWin;
  }

  loadKinds() {
    if (this.kinds) return this.kinds;
    const k = this.getMeta('kinds', null);
    if (k) this.kinds = k;
    else {
      // Rebuilding the totals reads the whole table: not once the tiers begin. They stay unsaved until it can.
      if (this.readTier() >= 1) return {};
      this.kinds = {};
      for (const r of this.run('SELECT kind, SUM(n) AS n FROM events GROUP BY kind')) this.kinds[r.kind] = r.n;
      this.kindsDirty = true;
    }
    return this.kinds;
  }

  // ---------------------------------------------------------------- intake

  insertEvent(e) {
    const at = Number(e.at) || Date.now();
    const team = e.team == null ? null : Number(e.team);
    if (e.kind === 'sign-in' && e.text === 'Session lapsed') {
      // Asked of the table by its time index, which reads only this hour's entries: never the whole window.
      if (this.one("SELECT 1 AS x FROM events WHERE at >= ? AND kind = 'sign-in' AND text = 'Session lapsed' AND team IS ? LIMIT 1", hourOf(at), team)) return;
    }
    // A day's cap on stored events: past it a new one is counted and dropped, except a failure.
    const meter = this.meterNow();
    if (e.sev !== 'bad') {
      if ((meter.events || 0) >= EVENTS_PER_DAY) { meter.dropped = (meter.dropped || 0) + 1; return; }
      meter.events = (meter.events || 0) + 1;
    }
    const row = {
      at, kind: String(e.kind || 'change').slice(0, 20), sev: String(e.sev || 'info').slice(0, 8), text: String(e.text || '').slice(0, 160),
      page: e.page ? String(e.page).slice(0, 40) : null, team, n: 1,
    };
    // Totals are loaded before the insert, so a first load from the table never counts this entry twice.
    const kinds = this.loadKinds();
    const r = this.one('INSERT INTO events (at, kind, sev, text, page, team) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      row.at, row.kind, row.sev, row.text, row.page, row.team);
    row.id = r ? r.id : null;
    if (this.recentWin && at >= this.recentWin.from) this.recentWin.rows.push(row);
    kinds[row.kind] = (kinds[row.kind] || 0) + 1;
    this.kindsDirty = true;
  }

  change(text, sev = 'info', page = null) {
    this.insertEvent({ at: Date.now(), kind: 'change', sev, text, page, team: null });
  }

  mergeHour(hour, fn) {
    const row = this.one('SELECT data FROM hours WHERE hour = ?', hour);
    let data = {};
    if (row) { try { data = JSON.parse(row.data); } catch { data = {}; } }
    fn(data);
    // Per-minute poll counts matter only for the last few minutes.
    const cutoff = Date.now() - 10 * 60000;
    for (const mins of Object.values(data.poll || {})) for (const m of Object.keys(mins)) if (Number(m) < cutoff) delete mins[m];
    this.run('INSERT INTO hours (hour, data) VALUES (?, ?) ON CONFLICT(hour) DO UPDATE SET data = excluded.data', hour, JSON.stringify(data));
    return data;
  }

  noteVersion(version) {
    if (!version) return;
    const seen = this.getMeta('version', null);
    if (seen && seen.build === version) return;
    this.setMeta('version', { build: version, since: new Date().toISOString(), previous: seen ? seen.build : null });
    if (seen && seen.build) this.change(`Version ${version} answered for the first time (previously ${seen.build})`, 'ok');
    else this.change(`Version ${version} answered for the first time`, 'ok');
  }

  checkBudget() {
    const m = this.meterNow();
    if (!m.reached && this.paused()) {
      m.reached = true;
      this.change('The log reached its daily budget: counters and status reports pause until 00:00 UTC', 'warn');
      this.saveMeter(true);
    }
  }

  checkErrors(hour, data) {
    let errs = data.exc || 0;
    for (const r of Object.values(data.req || {})) errs += r.e || 0;
    if (errs <= 10) return;
    const flagged = this.getMeta('errorsFlagged', 0);
    if (flagged === hour) return;
    this.setMeta('errorsFlagged', hour);
    this.change(`A burst of server errors: ${errs} this hour`, 'bad');
  }

  takeOps() {
    const ops = this.opsPending;
    this.opsPending = {};
    return Object.keys(ops).length ? ops : null;
  }

  ingest(body) {
    const events = Array.isArray(body.events) ? body.events.slice(0, 300) : [];
    const hours = Array.isArray(body.hours) ? body.hours.slice(0, 4) : [];
    this.transaction(() => {
      for (const e of events) this.insertEvent(e);
      this.noteSources(hours);
      if (!this.paused()) {
        for (const h of hours) {
          const hour = hourOf(Number(h.hour) || Date.now());
          const data = this.mergeHour(hour, (d) => mergeCounts(d, h.counts));
          this.checkErrors(hour, data);
        }
        this.noteLevel();
      }
      this.noteVersion(body.version);
      this.checkBudget();
      this.saveMeter();
    });
    return { ok: true, events: events.length, pace: this.paceUsage() };
  }

  /**
   * Sources the isolates saw: each fingerprint's alias (numbered in the order first seen, per family, for the
   * season), and page visits by team as daily counts kept 14 days (the likely member). Visits never stay in the
   * hour's counts. Written only when something changed.
   */
  noteSources(hours) {
    let aliases = null, matches = null, days = null, dirtyA = false, dirtyM = false, dirtyD = false;
    const today = dayOf(Date.now());
    for (const h of hours) {
      const c = h.counts || {};
      const hour = hourOf(Number(h.hour) || Date.now());
      for (const [id, src] of Object.entries(c.src || {})) {
        if (id === 'other') continue;
        aliases = aliases || this.getMeta('aliases', {}) || {};
        let a = aliases[id];
        if (!a) {
          if (Object.keys(aliases).length >= 1000) continue;
          const fam = src.f === 'IPv6' ? 'IPv6' : 'IPv4';
          let n = 0; for (const x of Object.values(aliases)) if (x.f === fam && x.n > n) n = x.n;
          a = aliases[id] = { f: fam, n: n + 1, first: hour, last: hour, days: 1, ld: today, k: src.k || null };
          dirtyA = true;
        }
        if (a.last < hour) { a.last = hour; dirtyA = true; }
        if (a.ld !== today) { a.ld = today; a.days = (a.days || 0) + 1; dirtyA = true; }
        const kind = src.ak || src.k;
        if (kind && kind !== 'unknown' && a.k !== kind && (src.ak || !a.k)) { a.k = kind; dirtyA = true; }
        // Each day's totals by source, kept 8 days for the Sources and Jobs panels (at most 200 sources a day).
        days = days || this.getMeta('srcdays', {}) || {};
        const dk = dayOf(hour);
        const day = days[dk] || (days[dk] = {});
        let t = day[id];
        if (!t) { if (Object.keys(day).length >= 200) continue; t = day[id] = { n: 0 }; }
        t.n += src.n || 0;
        for (const f of ['api', 'pg', 'hd', 'af']) if (src[f]) t[f] = (t[f] || 0) + src[f];
        for (const f of ['nm', 'nr', 'rf', 'key']) {
          if (!src[f]) continue;
          const g = t[f] || (t[f] = {});
          for (const [k, n] of Object.entries(src[f])) if (g[k] || Object.keys(g).length < 12) g[k] = (g[k] || 0) + n;
        }
        if (src.ak) t.k = src.ak; else if (src.k && src.k !== 'unknown' && !t.k) t.k = src.k;
        t.last = Math.max(t.last || 0, hour);
        dirtyD = true;
      }
      for (const [id, teams] of Object.entries(c.visits || {})) {
        matches = matches || this.getMeta('matches', {}) || {};
        const m = matches[id] || (matches[id] = {});
        for (const [team, n] of Object.entries(teams || {})) {
          const t = m[team] || (m[team] = {});
          t[today] = (t[today] || 0) + n;
          dirtyM = true;
        }
      }
      delete c.visits;
    }
    if (dirtyM) {
      const cutoff = dayOf(Date.now() - 14 * 86400000);
      for (const [id, m] of Object.entries(matches)) {
        for (const [team, days] of Object.entries(m)) {
          for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
          if (!Object.keys(days).length) delete m[team];
        }
        if (!Object.keys(m).length) delete matches[id];
      }
      this.setMeta('matches', matches);
    }
    if (dirtyA) this.setMeta('aliases', aliases);
    if (dirtyD) {
      const keep = dayOf(Date.now() - 8 * 86400000);
      for (const k of Object.keys(days)) if (k < keep) delete days[k];
      this.setMeta('srcdays', days);
    }
  }

  /** The load level each hour reached (its slowest), for the Pace panel's chart. */
  noteLevel(now = Date.now()) {
    try {
      const lvl = levelFrom(this.paceUsage(now), now);
      const lv = lvl.key;
      // The brake moving is a change of state, logged as it happens (C5).
      const brake = BRAKE_OF[lv] || 'normal', was = this.getMeta('brake', 'normal');
      if (brake !== was) {
        this.setMeta('brake', brake);
        const near = lvl.limit ? `${LIMIT_WORDS[lvl.limit]} at ${Math.round(lvl.frac * 100)}% of today's free limit` : '';
        this.change(brake === 'normal' ? 'The brake is off again: every page runs as usual'
          : `The brake moved to ${BRAKE_WORDS[brake]}${near ? `: ${near}` : ''}`, brake === 'normal' ? 'info' : brake === 'economy' ? 'warn' : 'bad');
      }
      const hour = hourOf(now);
      const row = this.one('SELECT data FROM hours WHERE hour = ?', hour);
      if (!row) return;
      let d = {}; try { d = JSON.parse(row.data); } catch { return; }
      if (d.lv && LEVEL_RANK[d.lv] >= LEVEL_RANK[lv]) return;
      d.lv = lv;
      this.run('UPDATE hours SET data = ? WHERE hour = ?', JSON.stringify(d), hour);
    } catch { /* the chart shows the hour as unknown */ }
  }

  /**
   * The likely member behind each alias asked for: the teams that opened the site from the same fingerprint in the
   * last 14 days. Answered only to the Admin Password popup's route; never part of a payload or an event.
   */
  members(list) {
    const aliases = this.getMeta('aliases', {}) || {};
    const matches = this.getMeta('matches', {}) || {};
    const want = new Set((Array.isArray(list) ? list : []).slice(0, 200).map(String));
    const out = {};
    for (const [id, a] of Object.entries(aliases)) {
      const name = `${a.f}:${a.n}`;
      if (!want.has(name)) continue;
      out[name] = { teams: likelyTeams(matches[id]), kind: a.k || null };
    }
    return { ok: true, members: out };
  }

  /**
   * The day's use of the limits the pace watches, with the recent hourly rate, for every isolate's pace.
   * Read from today's hours at most every 30 seconds; the log's own requests and rows come from its meter.
   */
  paceUsage(now = Date.now()) {
    const day = dayOf(now);
    if (this.pu && this.pu.day === day && now - this.pu.at < 30000) return this.pu;
    const mid = Math.floor(now / 86400000) * 86400000;
    const h0 = hourOf(now) - 3600000;
    const counts = { worker: 0, doReq: 0, rowsW: 0, kvR: 0, kvW: 0 }, recent = { ...counts };
    for (const r of this.run('SELECT hour, data FROM hours WHERE hour >= ?', Math.min(mid, h0))) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      const c = paceCountsOf(d);
      for (const k of Object.keys(counts)) {
        if (r.hour >= mid) counts[k] += c[k];
        if (r.hour >= h0) recent[k] += c[k];
      }
    }
    const m = this.meterNow(now);
    counts.doReq += m.req; counts.rowsW += m.rows;
    const spanH = Math.max(0.25, (now - h0) / 3600000);
    const rate = Object.fromEntries(Object.entries(recent).map(([k, v]) => [k, Math.round(v / spanH)]));
    // A cutoff pages saw in the last day travels with the counts, for the home page's note (C6).
    const o = this.getMeta('outage', null);
    const outage = o && now - o.reportedAt < 86400000 ? { seenAt: new Date(o.seenAt).toISOString(), until: new Date(Math.floor(o.seenAt / 86400000) * 86400000 + 86400000).toISOString() } : null;
    this.pu = { day, at: now, counts, rate, ...(outage ? { outage } : {}) };
    return this.pu;
  }

  tally(body) {
    const t = body && body.tally;
    if (!t || !body.key) return { ok: false };
    this.transaction(() => {
      if (!this.paused()) this.mergeHour(hourOf(Number(t.hour) || Date.now()), (d) => mergeTally(d, String(body.key), t));
      this.checkBudget();
      this.saveMeter();
    });
    return { ok: true };
  }

  /** The last tick, from memory, or from the newest hour row after a restart. */
  lastTickMinute() {
    if (this.lastTick !== undefined) return this.lastTick;
    let last = null;
    for (const r of this.run('SELECT data FROM hours ORDER BY hour DESC LIMIT 2')) {
      try { for (const m of Object.keys(JSON.parse(r.data).ticks || {})) if (last == null || Number(m) > last) last = Number(m); } catch { /* skip */ }
      if (last != null) break;
    }
    this.lastTick = last;
    return last;
  }

  /** The cron's tick: its summary, its isolate's counters, change detection, and once an hour, the reports. */
  async tick(body) {
    const t = (body && body.tick) || {};
    const at = Number(t.at) || Date.now();
    const minute = minuteOf(at);
    const hour = hourOf(at);
    let reportHour = null;
    this.transaction(() => {
      for (const e of (body.events || []).slice(0, 300)) this.insertEvent(e);
      const last = this.lastTickMinute();
      if (last != null && minute - last >= 3 * 60000) {
        const gap = Math.round((minute - last) / 60000) - 1;
        this.change(`Cron resumed after ${gap} minutes without a tick`, 'warn');
      }
      if (last == null && !this.getMeta('firstTick', null)) this.setMeta('firstTick', minute);
      this.lastTick = Math.max(minute, last || 0);
      if (!this.paused()) {
        const ops = this.takeOps();
        this.mergeHour(hour, (d) => {
          for (const h of body.hours || []) if (hourOf(Number(h.hour)) === hour) mergeCounts(d, h.counts);
          if (ops) mergeCounts(d, { ops });
          (d.ticks = d.ticks || {})[minute] = tickSummary(t.jobs);
        });
        for (const h of body.hours || []) {
          if (hourOf(Number(h.hour)) !== hour) this.mergeHour(hourOf(Number(h.hour)), (d) => mergeCounts(d, h.counts));
        }
      }
      this.noteLogos(t.jobs && t.jobs.logos);
      this.noteTimeline(t.jobs && t.jobs.timeline);
      this.noteVersion(body.version);
      const lastReport = this.getMeta('lastReportHour', null);
      if (lastReport == null) this.setMeta('lastReportHour', hour);
      else if (hour > lastReport) { reportHour = hour - 3600000; this.setMeta('lastReportHour', hour); }
      this.checkBudget();
      this.saveMeter();
    });
    this.cleanupAnonymous();
    // Outside the transaction: these read other stores.
    const census = this.getMeta('census', null);
    if (!census || at - Date.parse(census.at) >= CENSUS_EVERY_MS) {
      try {
        const c = await runCensus(this.env);
        this.transaction(() => { this.setMeta('census', c); this.saveMeter(); });
      } catch { /* the next tick tries again */ }
    }
    if (reportHour != null && !this.paused()) {
      try {
        const { lines, meta, events } = await hourlyReports(this.deps(), reportHour);
        this.transaction(() => {
          for (const l of lines) this.run('INSERT INTO reports (hour, sub, sev, text) VALUES (?, ?, ?, ?)', reportHour, l.sub, l.sev, l.text);
          for (const e of events || []) this.insertEvent({ at: Date.now(), kind: 'change', sev: e.sev, text: e.text, page: 'site-api', team: null });
          for (const [k, v] of Object.entries(meta || {})) this.setMeta(k, v);
          this.guard();
          this.saveMeter(true);
        });
      } catch { /* a missed report is shown as missing, never invented */ }
    }
    return { ok: true };
  }

  /**
   * Once: the sign-in visits and team-less sign-in entries a scanner left behind are removed, so the window and the
   * panels stop reading them. It is marked done only when it succeeded; a day's read limit already spent just
   * means it is tried again on the next tick, which is how it completes by itself after 00:00 UTC.
   */
  cleanupAnonymous() {
    try {
      if (this.getMeta('cleanup-signin-v1', false) || this.readsPaused()) return;
      this.transaction(() => {
        this.run("DELETE FROM events WHERE kind = 'visit' AND page = 'signin'");
        this.run("DELETE FROM events WHERE kind = 'sign-in' AND team IS NULL");
        this.run("DELETE FROM meta WHERE k = 'kinds'");
        this.kinds = null; this.kindsDirty = false; this.recentWin = null;
        this.setMeta('cleanup-signin-v1', true);
        this.change('Sign-in visits with no team chosen were cleared from the log (the site no longer records them)', 'info', 'signin');
      });
    } catch { /* tried again on the next tick */ }
  }

  /** Logo fetches that start or stop failing, from the logo pass the cron ran. */
  noteLogos(logos) {
    const res = logos && logos.result;
    if (!res || !Array.isArray(res.teams)) return;
    const was = this.getMeta('logoState', {}) || {};
    const now = {};
    for (const t of res.teams) {
      const k = String(t.teamId);
      now[k] = t.state === 'failed' ? 'failed' : 'ok';
      const name = t.name || `Team ${t.teamId}`;
      if (now[k] === 'failed' && was[k] !== 'failed') this.change(`Logo for ${name} failing to fetch${t.status ? ` (${t.status})` : ''}`, 'warn', 'home');
      else if (now[k] === 'ok' && was[k] === 'failed') this.change(`Logo for ${name} fetching again`, 'ok', 'home');
      else if (t.state === 'stored' && was[k] !== undefined) this.change(`Logo for ${name} changed`, 'info', 'home');
    }
    if (JSON.stringify(now) !== JSON.stringify(was)) this.setMeta('logoState', now);
  }

  /** A week's score timeline passing 80% of its byte budget, once per week. */
  noteTimeline(tl) {
    if (!tl || !tl.bytes || tl.bytes <= BYTE_BUDGET * 0.8) return;
    const k = `${tl.season}:${tl.week}`;
    if (this.getMeta('tl80', null) === k) return;
    this.setMeta('tl80', k);
    this.change(`Week ${tl.week}'s score timeline passed 80% of its byte budget (${Math.round((tl.bytes / BYTE_BUDGET) * 100)}%)`, 'warn', 'live-matchups');
  }

  /**
   * The storage guard: past 750 MB, the oldest day of visits is condensed into one
   * row per page and team. Sign-in, admin, operation and status entries are never touched.
   */
  guard(sizeOverride = null) {
    const size = sizeOverride != null ? sizeOverride : this.size();
    if (size < GUARD_BYTES) return false;
    const oldest = this.one("SELECT MIN(at) AS at FROM events WHERE kind = 'visit' AND n = 1 AND at < ?", Date.now() - 7 * 86400000);
    if (!oldest || oldest.at == null) return false;
    const d0 = Math.floor(oldest.at / 86400000) * 86400000, d1 = d0 + 86400000;
    const top = this.one('SELECT MAX(id) AS id FROM events').id;
    this.run(`INSERT INTO events (at, kind, sev, text, page, team, n)
      SELECT MIN(at), 'visit', 'info', text, page, team, COUNT(*) FROM events
      WHERE kind = 'visit' AND n = 1 AND at >= ? AND at < ? GROUP BY text, page, team`, d0, d1);
    this.run("DELETE FROM events WHERE kind = 'visit' AND n = 1 AND at >= ? AND at < ? AND id <= ?", d0, d1, top);
    this.setMeta('condensedThrough', d1);
    this.recentWin = null;
    this.change(`The log passed 750 MB: visits on ${new Date(d0).toISOString().slice(0, 10)} were condensed into daily summaries`, 'warn');
    return true;
  }

  /** An event sent from the browser: allow-listed by the Worker, at most 60 a minute site-wide. */
  clientEvent(body) {
    const now = Date.now(), m = minuteOf(now);
    if (this.client.minute !== m) this.client = { minute: m, n: 0 };
    this.client.n += 1;
    if (this.client.n > CLIENT_EVENTS_PER_MINUTE) {
      this.transaction(() => {
        const over = this.getMeta('clientOver', 0);
        this.setMeta('clientOver', over + 1);
      });
      return { ok: true, counted: false };
    }
    this.transaction(() => {
      this.insertEvent({ at: now, kind: body.limit ? 'change' : 'operation', sev: body.limit ? 'bad' : 'info', text: body.text, page: body.page, team: body.team });
      // The cutoff's record (C6): when pages first saw Cloudflare's limit page and when they were answered again,
      // for the home page's note the next day. The earliest sighting in the last day is kept.
      if (body.limit) {
        const seen = Number(body.seenAt);
        const at = Number.isFinite(seen) && seen <= now && now - seen < 86400000 ? seen : now;
        const o = this.getMeta('outage', null);
        const keep = o && now - o.reportedAt < 86400000 && o.seenAt <= at ? o.seenAt : at;
        this.setMeta('outage', { seenAt: keep, reportedAt: now });
      }
      this.saveMeter();
    });
    return { ok: true, counted: true };
  }

  // ---------------------------------------------------------------- reads

  /** Read-only helpers handed to the payload assembly. */
  deps(facts = {}) {
    return {
      env: this.env,
      facts,
      cache: this.cache,
      // From the first tier, nothing new is read from the events table (a lone MIN or MAX is one index step, and allowed).
      q: (query, ...b) => {
        const tier = this.readTier();
        if (tier >= 1 && /\bFROM\s+events\b/i.test(query) && !/^\s*SELECT\s+(MIN|MAX)\(/i.test(query)) throw this.restError(tier);
        return this.run(query, ...b);
      },
      tier: () => this.readTier(),
      meta: (k, f) => (k === 'kinds' ? { ...this.loadKinds() } : this.getMeta(k, f)),
      meter: () => ({ ...this.meterNow(), budget: LOG_BUDGET, paused: this.paused() }),
      size: () => this.size(),
      // The window answers for free once it is in memory (tier 1); from the second tier its panels rest.
      recent: () => {
        const tier = this.readTier();
        if (tier >= 2 || (tier === 1 && !this.recentWin)) throw this.restError(tier);
        return this.recent();
      },
      pace: () => this.paceUsage(),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      // A past season that never recorded anything is answered without creating a store for it.
      if (!this.ready && ['/tab', '/meta', '/dataset'].includes(url.pathname) && !this.hasTables()) {
        return json(url.pathname === '/tab' ? { ok: true, empty: true } : { ok: true, events: 0 });
      }
      this.init();
      this.meterNow().req += 1;
      switch (url.pathname) {
        case '/ingest': return json(this.ingest(body));
        case '/tally': return json(this.tally(body));
        case '/tick': return json(await this.tick(body));
        case '/client': return json(this.clientEvent(body));
        case '/pace': return json({ ok: true, pace: this.paceUsage() });
        case '/devtier': {
          if (!this.env.DEV_TOKEN) return json({ ok: false, error: 'unknown log route' }, 404);
          const n = Number(body.tier);
          if (body.cold) this.recentWin = null;
          this.devTier = n >= 0 && n <= 3 && body.minutes > 0 ? { n, until: Date.now() + Math.min(180, Number(body.minutes)) * 60000 } : null;
          return json({ ok: true, tier: this.readTier(), until: this.devTier ? new Date(this.devTier.until).toISOString() : null });
        }
        case '/members': return json(this.members(body.aliases));
        case '/tab':
        {
          // The whole share spent: the panels built from the events rest (as at the second tier), the rest carry on,
          // and each tab is answered from a copy at most a minute old, so the small reads that are left stay small.
          const spent = this.readTier() >= 3;
          const ck = spent ? JSON.stringify(body.params || {}) : null;
          if (spent) {
            const hit = this.tabCache && this.tabCache.get(ck);
            if (hit && Date.now() - hit.at < 60000) return json(hit.out);
          }
          const out = await assembleTab(this.deps(body.facts || {}), body.params || {});
          if (spent) {
            if (!this.tabCache) this.tabCache = new Map();
            if (this.tabCache.size >= 40) this.tabCache.clear();
            this.tabCache.set(ck, { at: Date.now(), out });
          }
          return json(out);
        }
        case '/dataset': return json(await datasetDetail(this.deps(body.facts || {}), body.key || url.searchParams.get('key')));
        case '/meta': {
          const r = this.one('SELECT MAX(id) AS n, MIN(at) AS first, MAX(at) AS last FROM events');
          return json({ ok: true, events: r.n || 0, first: r.first, last: r.last, size: this.size(), meter: this.meterNow() });
        }
        default: return json({ ok: false, error: 'unknown log route' }, 404);
      }
    } catch (err) {
      if (err && err.logPaused && url.pathname === '/tab') return json({ ok: true, empty: true, paused: true });
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  }
}
