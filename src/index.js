/**
 * Worker entrypoint.
 *
 * `run_worker_first` is true, so every request lands here first — including
 * requests that would otherwise be answered directly from static assets. That
 * is the mechanism that makes the League Password check unbypassable: there is
 * no path by which the edge serves a file without this code running. Static
 * assets are reached only through env.ASSETS, and only after the gate passes.
 */

import { llmExportPayload, applyLiveScoring } from './llmexport.js';
import { fortuneTellerPayload, fortuneTellerMap, simOdds } from './fortuneteller.js';
export { FortuneTellerDO } from './ftdo.js';
import { FT_ACTIVE_KEY } from './ftdo.js';
import { DATASETS, getDataset, planBatches, PARAM_DATASETS, TTL } from './datasets.js';
import { loadConfig, saveConfig, describeConfig, isConfigured, isSetupFinished, canCallEspn, workersOriginOf } from './config.js';
import { coordinatorRefresh } from './dedupe.js';
import { getPart, headPart, readStatus, isFresh, ageSeconds } from './store.js';
import {
  hasLeagueSession, verifyPassword, hashPassword, createSession, sessionCookie,
  clearSessionCookie, checkAdminPassword, readCookie, readSession, SESSION_TTL_SECONDS, SESSION_STOPS, sessionHoursOf, sessionSecondsOf, sessionWords,
} from './auth.js';
import { setupCodeRequired, verifySetupCode, completePasswordSetup } from './setup.js';
import { throttleCheck, throttleFail, throttleSucceed } from './throttle.js';
import { loginPage, dashboardPage } from './pages.js';
import { wizardPage } from './wizard.js';
import { siteConfigPage } from './siteconfig.js';
import { shell, backAction, displayTitle, passwordField, esc, LOGO_FALLBACK_SVG,
  THEME_COOKIE, TEAM_COOKIE, MOTION_COOKIE, FAVICON_SVG} from './ui.js';
import { adminGateRail, adminGateSection, ADMIN_GATE_CSS } from './admingate.js';
import { TOOLS, LEAGUE_TOOLS, describeTools, applyVisibility, visibleTools, visibilityOf, VISIBILITY,
  orderTiles, normaliseTileOrder, describeTileOrder, defaultTileOrder, SITE_CONFIG_TOOL } from './tools.js';
import {
  beginRequest, finishRequest, traceOf, note, markPage, noteLapsed, countException, countOp,
  sendTick, meteredEnv, isolateFacts, logStub, seasonAt, FIRST_LOG_SEASON, brakeNow, paceCheckIn, paceUsage, knowsSetUp,
} from './sitelog.js';
import { refreshAllowed, objectCallAllowed, BLIND_AFTER_MS } from './budget.js';
import { MARK_HEADER, busyWarning, LIMIT_COPY } from './pages/limitnotice.js';
import { swScript, restingPage, RESTING_PATH } from './sw.js';
import { SHARE_PARAMS, DATA_ROUTE_DATASETS, apiTool } from './readers.js';
import { BUILD_INFO } from './generated/build-info.js';
import { runBatch, readJob, jobStatus } from './history.js';
import { runPrimeBatch, primeStatus, missingDatasetKeys } from './prime.js';
import { fetchPart } from './espn.js';
import { buildLiveScoringDigest, teamLogoUrl } from './derive.js';
import { putPart } from './store.js';
import { timelineAppend, timelineRead } from './timeline.js';
import { refreshLogos, logoObjectKey, LOGO_REFRESH_MS } from './logos.js';
import { readEspnAuth } from './espnhealth.js';
import { json, html, readJson, b64urlDecode } from './http.js';

export { DatasetCoordinator } from './coordinator.js';
export { LoginThrottle } from './throttle.js';
export { ScoreTimelineDO } from './scoretimeline.js';
export { SiteLogDO } from './sitelogdo.js';
export { SourcePaceDO } from './pacerecord.js';
export { BackendClockDO } from './clock.js';
import { handleSiteApi, apiSettings, forgetApiSettings, clientAddress } from './siteapi.js';
import { fingerprint, programKind } from './sources.js';
import { siteApiPageRoute } from './siteapipage.js';
import { started as startedKey, normaliseSiteApi, replaced as replacedKey, dueChange, adminFacts, INTERVALS as KEY_INTERVALS } from './apikey.js';
import { RELEASE_NOTE_ITEMS } from './release.js';
import { TRADE_ROWS } from './traderows.js';

const BUILD_MARKER = 'r203';



/**
 * Whether this release needs the *historical* pull re-run, as opposed to the
 * ordinary league pull.
 *
 * Nearly every release that adds data adds a registered dataset, and those are
 * detected automatically — see repullBannerNeeded below. The box-score history
 * job has no comparable per-key registry to diff against, so the rare release
 * that needs it says so here rather than being guessed at.
 */
const NEEDS_HISTORY_REPULL = false;

/** The version as a reader sees it. Derived from the build marker, never typed twice. */
function displayVersion() {
  const m = /(\d+)$/.exec(BUILD_MARKER);
  return m ? `1.${m[1]}` : BUILD_MARKER;
}

export default {
  async fetch(request, rawEnv, ctx) {
    rawEnv.BUILD_MARKER = BUILD_MARKER;
    // The brake (C5): as a daily limit fills, the frontend slows down so the backend keeps its reserve. Every
    // request here is frontend; the backend (the clock, the cron) runs elsewhere and never reads the brake.
    const brakeInfo = brakeNow();
    const brake = brakeInfo.brake;
    // Every R2, KV and Durable Object call is counted for Site Backend's usage panel.
    const env = brake === 'normal' ? meteredEnv(rawEnv) : { ...meteredEnv(rawEnv), BRAKE: brake };
    // An isolate that has not heard the day's counts (or not for 10 minutes) checks in once, behind the response.
    const usage = paceUsage();
    if (rawEnv.SITE_LOG && knowsSetUp() && (!usage || Date.now() - usage.heardAt > BLIND_AFTER_MS) && ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(paceCheckIn(rawEnv).catch(() => {}));
    }
    const trace = beginRequest(request);
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (err) {
      countException();
      response = json(
        { ok: false, error: 'unhandled worker exception', detail: String((err && err.stack) || err) },
        500
      );
    }
    finishRequest(rawEnv, ctx, request, response, { recording: Boolean(trace && trace.record), version: BUILD_MARKER, brake });
    // Every answer carries the site's own marker, so a page can tell the site's answers from Cloudflare's limit page
    // (C6); pages read the brake from it and slow their polls to match (the API carries its own pace), and once a
    // limit is reached it names the limit, so every open page can say so.
    if (response) {
      try {
        response = new Response(response.body, response);
        response.headers.set(MARK_HEADER, '1');
        if (brake !== 'normal' && !response.headers.has('x-suggested-interval')) response.headers.set('x-brake', brake);
        if (brake === 'limit' && brakeInfo.limit && brakeInfo.limit !== 'worker') response.headers.set('x-limit', brakeInfo.limit);
      } catch { /* an answer that cannot be copied keeps its own headers */ }
    }
    return response;
  },

  /**
   * Cron Trigger, once a minute.
   *
   * The minute's work (runMinute below) is the site's backend: it must never stop. Where the backend clock is on
   * (BACKEND_CLOCK = "on", dev for now), the cron only knocks on the clock object, which does the work once a
   * minute from its own alarm or this knock, whichever comes first (C5). If the knock fails the cron does the work
   * itself, so a broken clock can never cost a minute. Everywhere else the cron does the work, as it always has.
   */
  async scheduled(event, rawEnv, ctx) {
    rawEnv.BUILD_MARKER = BUILD_MARKER;
    const at = (event && event.scheduledTime) || Date.now();
    if (clockIsOn(rawEnv)) {
      try {
        const r = await rawEnv.CLOCK.get(rawEnv.CLOCK.idFromName('clock')).fetch(`https://clock/knock?at=${at}`);
        if (r.ok) return;
      } catch (err) {
        console.log('clock knock failed:', String((err && err.stack) || err));
      }
      await runMinute(rawEnv, { at, via: 'cron', cron: event && event.cron, fallback: true });
      return;
    }
    await runMinute(rawEnv, { at, via: 'cron', cron: event && event.cron });
  },
};

/** Whether the backend clock does the minute's work (C5): on where the deployment says so, and has the object. */
export function clockIsOn(env) {
  return Boolean(env && env.CLOCK && String(env.BACKEND_CLOCK || '').toLowerCase() === 'on');
}

/**
 * The minute's work: the score timeline, logos, Fortune Teller's pipeline check and build nudge, the site log's
 * tick and the Site API key's due date. Run by the cron, or by the backend clock object (src/clock.js) from its
 * alarm or the cron's knock. Deliberately cheap in the common case: it reads the already-stored live digest, and if
 * nothing in it is actually in play it returns without calling ESPN at all. `via` (alarm, knock or cron) and how
 * late the minute's work began are recorded with the tick, so Site Backend can show which clock kept each minute.
 */
export async function runMinute(rawEnv, { at = Date.now(), via = 'cron', cron = null, fallback = false, heard = null } = {}) {
    rawEnv.BUILD_MARKER = BUILD_MARKER;
    const env = meteredEnv(rawEnv);
    const event = { scheduledTime: at, cron };
    const jobs = {};
    const minuteStart = Math.floor(at / 60000) * 60000;
    jobs.clock = { via, late: Math.max(0, Date.now() - minuteStart), ...(fallback ? { fallback: true } : {}),
      // Whether the alarm and the cron's knock were each heard the minute before (1 or 0), whoever did the work.
      ...(heard ? { ha: heard.alarm ? 1 : 0, hk: heard.knock ? 1 : 0 } : {}) };
    const timed = async (name, fn, shape) => {
      const t0 = Date.now();
      try {
        jobs[name] = { ...shape(await fn()), ms: Date.now() - t0 };
      } catch (err) {
        jobs[name] = { error: String((err && err.message) || err).slice(0, 120), ms: Date.now() - t0 };
        console.log(`scheduled ${name} failed:`, String((err && err.stack) || err));
      }
    };
    await timed('timeline', () => tickTimeline(env), (r) => ({
      recorded: Boolean(r && r.timeline && r.timeline.appended), skipped: (r && r.skipped) || null,
      matchups: (r && r.matchups) || 0, bytes: (r && r.timeline && r.timeline.bytes) || null,
      week: (r && r.week) || null, season: (r && r.season) || null,
    }));
    await timed('logos', () => tickLogos(env, event), (r) => (r ? {
      ran: true, seen: r.teamsSeen || 0, changed: r.changed || 0, failed: r.failed || 0, fetched: (r.changed || 0) + (r.failed || 0),
      result: { teams: (r.teams || []).map((t) => ({ teamId: t.teamId, name: t.name, state: t.state, status: t.status || null })) },
    } : { ran: false }));
    await timed('ft', () => fortuneTellerCheck(env), (r) => (r ? { ran: true, state: r.state || null } : { ran: false }));
    let nudge = null;
    await timed('nudge', async () => { nudge = await nudgeFortuneTeller(env); return nudge; }, (r) => ({
      ran: Boolean(r && typeof r === 'object'), result: typeof r === 'string' ? r : r && r.ran ? `ran ${r.ran} slice${r.ran === 1 ? '' : 's'}` : r && r.paused ? 'build paused' : r && r.onTime ? 'on time' : r && r.idle ? 'no build' : null,
    }));
    // The site log's record of this tick: what makes "last tick" and gap detection possible.
    try {
      const cfg = await loadConfig(env);
      if (isSetupFinished(cfg)) await sendTick(rawEnv, { at, ms: Date.now() - at, jobs }, { version: BUILD_MARKER });
    } catch (err) {
      console.log('scheduled log tick failed:', String((err && err.stack) || err));
    }
    // The backend's own check on the Site API key: a replacement that falls due (Season End above all) happens
    // even when no request comes. Reads the config the tick just loaded; writes only when a change is due.
    try { await apiSettings(env, Date.now()); } catch { /* the next request or tick tries again */ }
    return jobs;
}

/**
 * Fortune Teller's pipeline check, every 15 minutes: the schedule and settings are brought
 * up to date here (every read goes through ensureDataset), then the build object decides
 * what should happen and starts it. Nothing runs until setup is finished.
 */
/** The league's number of playoff places, for the line under the last of them. */
async function playoffPlaces(env, ctx) {
  try { const s = await readDigest(env, 'league_settings', ctx); const n = s && s.settings && s.settings.scheduleSettings && s.settings.scheduleSettings.playoffTeamCount; return Number(n) || null; } catch { return null; }
}

async function fortuneTellerCheck(env) {
  if (!env.FORTUNE || new Date().getUTCMinutes() % 15 !== 0) return;
  const cfg = await loadConfig(env);
  if (!isSetupFinished(cfg)) return;
  await ensureDataset(env, 'season_schedule', null);
  await ensureDataset(env, 'league_settings', null);
  await ensureDataset(env, 'standings_digest', null);
  const r = await env.FORTUNE.get(env.FORTUNE.idFromName('fortune-teller')).fetch('https://ft/pipeline?reason=cron');
  const body = r.ok ? await r.json().catch(() => null) : null;
  return (body && body.pipeline) || { state: null };
}

/**
 * Keep a Fortune Teller build moving even if its own alarms stop being delivered
 * (seen on dev: a build's alarms stopped for hours while every other request to
 * the object worked). Runs last in the minute cron so it never delays the score
 * timeline, and costs one small R2 read a minute while no build is active.
 */
async function nudgeFortuneTeller(env) {
  if (!env.FORTUNE) return 'no binding';
  const active = await env.DATA.get(FT_ACTIVE_KEY);
  if (!active) return 'no build active';
  const stub = env.FORTUNE.get(env.FORTUNE.idFromName('fortune-teller'));
  const r = await stub.fetch('https://ft/tick');
  return r.ok ? await r.json() : { status: r.status };
}

/**
 * Keep the stored team logos in step with ESPN.
 *
 * The cron already fires every minute for the score timeline, so this needs no
 * second trigger and no wrangler change — which matters, because a fork gets
 * its triggers from the committed config and nothing else.
 *
 * A pass every fifth minute is enough for "someone changed their logo and it
 * turned up shortly after" without spending an ESPN call a minute on something
 * that changes a handful of times a season. The gate is arithmetic on the
 * scheduled time rather than a stored last-run marker: it holds no state, it
 * cannot drift, and a failed pass cannot wedge the next one.
 */
async function tickLogos(env, event) {
  const at = (event && event.scheduledTime) || Date.now();
  const everyMinutes = Math.max(1, Math.round(LOGO_REFRESH_MS / 60000));
  if (Math.floor(at / 60000) % everyMinutes !== 0) return;

  const cfg = await loadConfig(env);
  if (!canCallEspn(cfg)) return;
  return refreshLogos(env, cfg);
}

/**
 * Record one row of the week's score timeline, if a row is warranted.
 *
 * The gate is kickoff times, not live state.
 *
 * The obvious version of this asked the stored digest whether anything was
 * live, and only refreshed if it said yes. That cannot work: the digest only
 * flips from "pre" to "live" when something refreshes it, and the only thing
 * that would have refreshed it was this function, which was waiting for it to
 * say live. With nobody visiting the site all Sunday, the whole afternoon went
 * unrecorded — which defeats the entire reason a cron exists here.
 *
 * Kickoff times do not have that problem. They are known days ahead and do not
 * change, so a slightly stale scoreboard still says exactly when this week's
 * games start. The board is refreshed hourly regardless, so next week's
 * kickoffs arrive without anyone opening the site.
 */

/** A fixture is worth polling from just before kickoff until well after it. */
const GAME_LEAD_MS = 2 * 60 * 1000;
const GAME_TAIL_MS = 4.5 * 60 * 60 * 1000;
/** How often the schedule itself is re-read when nothing is being played. */
const BOARD_REFRESH_MS = 60 * 60 * 1000;

export async function tickTimeline(env) {
  const cfg = await loadConfig(env);
  if (!isSetupFinished(cfg) || !canCallEspn(cfg)) {
    return { ok: true, skipped: 'site not ready' };
  }

  let board = await readDigestPlain(env, 'scoreboard_digest');
  const now = Date.now();

  // Keep the schedule current even in an empty week, so the window test below
  // is never deciding from last week's fixtures.
  const boardAge = board && board.generatedAt ? now - Date.parse(board.generatedAt) : Infinity;
  if (!board || !Number.isFinite(boardAge) || boardAge > BOARD_REFRESH_MS) {
    await coordinatorRefresh(env, 'scoreboard_digest', false);
    board = (await readDigestPlain(env, 'scoreboard_digest')) || board;
  }
  if (!board) return { ok: true, skipped: 'no scoreboard yet' };

  const inWindow = (board.games || []).some((g) => {
    if (g.final) return false;
    const k = Date.parse(g.kickoff || '');
    if (!Number.isFinite(k)) return false;
    return now >= k - GAME_LEAD_MS && now <= k + GAME_TAIL_MS;
  });
  if (!inWindow) return { ok: true, skipped: 'no game window' };

  // Inside a window, so it is worth paying for a genuinely current view. This
  // also cascades a scoreboard refresh through the digest's declared needs.
  await coordinatorRefresh(env, 'live_scoring', false);
  const digest = await readDigestPlain(env, 'live_scoring_digest');
  if (!digest) return { ok: true, skipped: 'no digest yet' };

  const m = {};
  const p = {};
  const pm = {};
  for (const g of digest.games || []) {
    m[g.id] = [g.home.points, g.away.points, g.home.winProb];
    // Starters only. A bench player's points are real but never scored, and a
    // feed that reported them would be describing a game nobody is playing.
    for (const side of [g.home, g.away]) {
      for (const pl of side.starters || []) {
        if (pl.id == null) continue;
        p[pl.id] = pl.points;
        pm[pl.id] = g.id;
      }
    }
  }
  const res = await timelineAppend(env, digest.season, digest.matchupPeriod, m, Date.now(), p, pm);
  return { ok: true, matchups: Object.keys(m).length, players: Object.keys(p).length, timeline: res,
    season: digest.season, week: digest.matchupPeriod };
}

/**
 * Does this deployment need a re-pull to finish an update?
 *
 * Cost is the whole design here. The check reads one status document per
 * registered dataset, which is far too much to spend on every dashboard load
 * forever — so a site that passes records the build it passed against, and every
 * later load until the next deploy is a string comparison against config that
 * was already loaded. A site that fails is *not* cached: the banner has to
 * disappear the moment the re-pull is run, not whenever a cache lapses.
 *
 * The failure path is silent by design. This decides whether to show a notice;
 * a store hiccup that makes it throw should cost the notice, never the page.
 */
async function repullBannerNeeded(env, cfg) {
  try {
    if (!isSetupFinished(cfg)) return false;
    if (cfg.datasetsCheckedVersion === BUILD_MARKER) return false;
    const missing = await missingDatasetKeys(env, cfg);
    if (missing.length === 0) {
      await saveConfig(env, { datasetsCheckedVersion: BUILD_MARKER });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Read a stored digest without the ensure/revalidate machinery. */
async function readDigestPlain(env, key) {
  const obj = await getPart(env, key, 'main');
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

const themeOf = (request) => (readCookie(request, THEME_COOKIE) === 'light' ? 'light' : 'dark');
const motionOf = (request) => readCookie(request, MOTION_COOKIE) === 'reduce';
const isApi = (path) => path.startsWith('/api/');

/* The site's workers.dev address is noted once, the first time a set-up site is asked for there (one settings
   write, ever), so Site API's guides can name it even when the page is opened at a custom domain. */
let workersOriginNoted = false;
function noteWorkersOrigin(env, ctx, cfg, url) {
  if (workersOriginNoted || !cfg || cfg.workersOrigin || !isSetupFinished(cfg)) return;
  const origin = workersOriginOf(url.origin);
  if (!origin) return;
  workersOriginNoted = true;
  const p = saveConfig(env, { workersOrigin: origin }).catch(() => { workersOriginNoted = false; });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/health') {
    return json({
      ok: true,
      build: BUILD_MARKER,
      time: new Date().toISOString(),
      bindings: {
        CONFIG: Boolean(env.CONFIG), DATA: Boolean(env.DATA),
        COORDINATOR: Boolean(env.COORDINATOR), THROTTLE: Boolean(env.THROTTLE),
        SCORE_TIMELINE: Boolean(env.SCORE_TIMELINE),
        FORTUNE: Boolean(env.FORTUNE), SITE_LOG: Boolean(env.SITE_LOG), SOURCE_PACE: Boolean(env.SOURCE_PACE), CLOCK: Boolean(env.CLOCK),
        ASSETS: Boolean(env.ASSETS),
      },
    });
  }

  /* The tab icon, ahead of the gate.
   *
   * `run_worker_first` means even a favicon request lands here, so without an
   * exemption the icon 401s on exactly the two surfaces a fresh visitor sees
   * first: the login page and the setup wizard. It is a static file that holds
   * no league data and triggers no upstream fetch, so serving it unauthenticated
   * gives nothing away — the same reasoning that already exempts /api/health. */
  /* Both spellings. A browser asks for /favicon.ico of its own accord when the
     declared icon is not used, and behind the gate that request answered 401 —
     which is a page, not an image, so the tab fell back to nothing. */
  if (path === '/favicon.svg' || path === '/favicon.ico') {
    return new Response(FAVICON_SVG, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        // Long-lived but revalidated, so a browser that cached the earlier
        // absence picks the icon up rather than holding the miss for a year.
        'cache-control': 'public, max-age=3600, must-revalidate',
      },
    });
  }

  /* The browser helper (C6) and the resting page it keeps, ahead of the gate: neither holds league data. The
     helper is fetched afresh on every check (no-cache), so its kill switch reaches every browser within about a day. */
  if (path === '/sw.js') {
    return new Response(swScript(), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/' } });
  }
  if (path === RESTING_PATH) {
    return new Response(restingPage('worker', { clockOn: clockIsOn(env) }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  }

  /* Site API, first in line: opened by the league's key alone, never by the sign-in cookie, and answered
     before the League Password gate with the site's settings held 60 seconds per isolate. */
  if (path === '/api/v1' || path.startsWith('/api/v1/')) return handleSiteApi(request, env, ctx);

  // An isolate that cannot read its settings (the day's KV reads spent) shows the site's own resting page (C6).
  let cfg;
  try { cfg = await loadConfig(env); } catch (err) {
    console.log('settings could not be read:', String((err && err.message) || err));
    if (isApi(path)) return json({ ok: false, error: 'The site has used today’s free allowance of settings reads; it carries on at 00:00 UTC.', limit: 'kvR' }, 503, { 'x-limit': 'kvR' });
    return new Response(restingPage('kv', { clockOn: clockIsOn(env) }), { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-limit': 'kvR' } });
  }
  const theme = themeOf(request);
  const reduceMotion = motionOf(request);
  noteWorkersOrigin(env, ctx, cfg, url);
  // Recording starts when setup finishes: a site still in its wizard records nothing.
  const trace = traceOf(request);
  if (trace) trace.record = isSetupFinished(cfg);
  // Every recorded request is counted by its source (D36, D37): a keyed fingerprint of the address, never the
  // address, and the kind of program in one word, never the user agent. Only for High activity and the likely member.
  if (trace && trace.record && cfg.sessionSecret) {
    try { trace.fp = await fingerprint(cfg.sessionSecret, clientAddress(request)); trace.kind = programKind(request.headers.get('user-agent')); } catch { trace.fp = null; }
  }

  // ---- first run --------------------------------------------------------
  if (!isConfigured(cfg)) {
    if (path === '/api/setup/status') {
      return json({ ok: true, configured: false, codeRequired: setupCodeRequired() });
    }
    if (path === '/api/setup/check-code') {
      if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
      const body = await readJson(request);
      return (await verifySetupCode(body && body.setupCode))
        ? json({ ok: true })
        : json({ ok: false, error: 'That setup code is not correct.' }, 403);
    }
    if (path === '/api/setup/passwords') {
      if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
      return handleSetupPasswords(request, env, cfg);
    }
    if (isApi(path)) return json({ ok: false, error: 'This site has not been configured yet.' }, 409);
    return html(wizardPage({ theme, reduceMotion, codeRequired: setupCodeRequired(), step: 1 }));
  }

  // ---- configured: auth endpoints ---------------------------------------
  if (path === '/api/setup/status') {
    return json({ ok: true, configured: true, finished: isSetupFinished(cfg), codeRequired: false });
  }
  if (path === '/api/setup/passwords') {
    return json({ ok: false, error: 'This site is already configured.' }, 409);
  }
  if (path === '/api/setup/finish' && isSetupFinished(cfg)) {
    return json({ ok: true, alreadyFinished: true });
  }
  if (path === '/api/auth/login') {
    if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
    return handleLogin(request, env, cfg);
  }
  if (path === '/api/auth/logout') {
    if (await hasLeagueSession(request, cfg)) note(request, 'sign-in', 'Signed out', { page: 'signin' });
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
  }

  // ---- the gate ----------------------------------------------------------
  if (!(await hasLeagueSession(request, cfg))) {
    // A tool's own data route answers like any API: a status, never the sign-in page.
    if (isApi(path) || /^\/apps\/[^/]+\/api$/.test(path)) {
      // A page left open past its session keeps polling: noted once per team per hour.
      if (path !== '/api/site-log/event') noteLapsed(request);
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
    markPage(request, 'signin', 'Sign-in');
    return html(loginPage({ leagueName: await leagueName(env), season: cfg.season,
      theme, reduceMotion }), 401);
  }

  // ---- wizard continuation (passwords set, league not connected yet) -----
  if (!isSetupFinished(cfg)) {
    if (path === '/api/setup/league') return handleSetupLeague(request, env, cfg);
    if (path === '/api/setup/tools') return handleSetupTools(request, env, cfg);
    if (path === '/api/setup/history-batch') return handleHistoryBatch(request, env, cfg);
    if (path === '/api/setup/prime-batch') return handlePrimeBatch(request, env, cfg);
    if (path === '/api/setup/finish') return handleSetupFinish(request, env, cfg);
    if (!isApi(path)) {
      // Resume where the wizard actually got to. Sending every reload back to
      // step 3 meant an interruption during the history pull silently discarded
      // a league connection that had already been saved.
      return html(wizardPage({
        theme, reduceMotion, codeRequired: false,
        step: cfg.leagueId ? 4 : 3,
        leagueName: await leagueName(env),
      }));
    }
  }

  // ---- authenticated -----------------------------------------------------
  if (path === '/api/auth/status') return json({ ok: true, authenticated: true, build: BUILD_MARKER });
  if (path === '/api/dashboard/status') return dashboardStatus(env, ctx, url);
  if (path === '/api/dashboard/board') return dashboardBoard(env, ctx, url);
  if (path.startsWith('/api/admin/')) {
    // Saving settings is the one thing the day's KV writes limit stops (C6): Site Configuration says why and when.
    try { return await handleAdmin(request, env, cfg, path); } catch (err) {
      const msg = String((err && err.message) || err);
      if (brakeNow().limit === 'kvW' || /\bKV\b|limit|exceed|quota/i.test(msg)) {
        return json({ ok: false, error: 'Saving settings waits until 00:00 UTC: the site has used today’s free allowance of settings writes. Everything else carries on.', limit: 'kvW' }, 503, { 'x-limit': 'kvW' });
      }
      throw err;
    }
  }

  if (path === '/api/meta') {
    return json({
      ok: true,
      build: BUILD_MARKER,
      // Client-rendered tools build their own header and need the league name
      // for it. Reading it here rather than hardcoding a fallback is what keeps
      // a forked deployment showing its own league rather than this one's.
      leagueName: await leagueName(env, { ensure: true, ctx }),
      config: describeConfig(cfg),
      tools: describeTools(cfg),
      datasets: DATASETS.map((d) => ({
        key: d.key, label: d.label, group: d.group, tier: d.tier,
        ttl: d.ttl, auth: d.auth, parts: d.parts(cfg).length,
      })),
      paramDatasets: Object.keys(PARAM_DATASETS),
      batches: planBatches(cfg, 30),
    });
  }

  if (path === '/api/tools/unlock') return handleToolUnlock(request, env, cfg);
  if (path === '/api/site-log/event') return siteLogEvent(request, env);

  // A hidden tool is off for everyone: its data routes are blocked along with its page.
  const owner = apiTool(path);
  if (owner && visibilityOf(cfg, owner) === VISIBILITY.HIDDEN) {
    return json({ ok: false, error: 'This tool is switched off for your league.' }, 403);
  }

  if (path.startsWith('/api/live/')) {
    return handleLive(env, cfg, path.slice('/api/live/'.length), url, ctx);
  }

  // Draft Helper's poll: every dataset that is due, in one request.
  if (path === '/api/data') return dataBatch(env, cfg, url, ctx);

  if (path.startsWith('/api/data/')) {
    const rest = path.slice('/api/data/'.length).replace(/\.json$/, '');
    const [key, partRaw] = rest.split('/');
    // Only what Draft Helper reads. Every other dataset is reached through the page that shapes it.
    if (!DATA_ROUTE_DATASETS.has(key)) return json({ ok: false, error: `no route for ${path}` }, 404);
    return serveDataset(env, cfg, key, partRaw || 'main', url, ctx, request);
  }

  if (path === '/api/hof') return hallOfFame(env, ctx);
  if (path === '/api/trade') return tradeAnalyzer(env, ctx);
  if (path === '/api/llm-export') return llmExport(env, ctx, url);
  if (path === '/api/fortune-teller') {
    // The page before a map exists is built from the standings and the league's rules.
    await Promise.all([ensureDataset(env, 'standings_digest', ctx), ensureDataset(env, 'league_settings', ctx), ensureDataset(env, 'season_schedule', ctx)]);
    return json(await fortuneTellerPayload(env));
  }
  if (path.startsWith('/api/fortune-teller/map/')) return fortuneTellerMap(env, path.slice('/api/fortune-teller/map/'.length));

  if (path === '/api/img') return serveImage(request, url, ctx);

  if (path.startsWith('/api/logo/')) {
    return serveTeamLogo(env, request, url, ctx, path.slice('/api/logo/'.length));
  }

  if (isApi(path)) return json({ ok: false, error: `no route for ${path}` }, 404);

  // ---- pages -------------------------------------------------------------
  if (path === '/config' || path === '/config/') {
    markPage(request, 'config', 'Site Configuration');
    return html(siteConfigPage({ theme, reduceMotion,
      leagueName: await leagueName(env, { ensure: true, ctx }) }));
  }

  if (path === '/' || path === '/index.html') {
    markPage(request, 'home', 'Home');
    const selectedTeam = readCookie(request, TEAM_COOKIE) || '';
    const [teams, initial, board, repullNeeded] = await Promise.all([
      getTeams(env, ctx),
      dashboardPayload(env, ctx),
      boardPayload(env, ctx, selectedTeam),
      repullBannerNeeded(env, cfg),
    ]);
    return html(dashboardPage({
      leagueName: await leagueName(env, { ensure: true, ctx }),
      season: cfg.season,
      theme, reduceMotion,
      tools: orderTiles(cfg, [...visibleTools(cfg), siteConfigTile()]),
      teams,
      selectedTeamId: selectedTeam,
      initial, board,
      espnAuth: await readEspnAuth(env),
      version: displayVersion(),
      releaseItems: RELEASE_NOTE_ITEMS,
      repullNeeded,
      needsHistoryRepull: NEEDS_HISTORY_REPULL,
    }));
  }

  // Tool routes respect the three-state visibility flag.
  const toolMatch = /^\/apps\/([^/]+)/.exec(path);
  if (toolMatch) {
    const key = toolMatch[1];
    const tool = TOOLS.find((t) => t.key === key);
    if (!tool) return new Response('not found', { status: 404 });

    const vis = visibilityOf(cfg, key);
    const siteBackendApi = key === 'site-backend' && path === '/apps/site-backend/api';
    // Site API's page route: under the tool's own path, so the unlock cookie reaches it; never cached.
    const siteApiPage = key === 'site-api' && path === '/apps/site-api/api';
    if (vis === VISIBILITY.HIDDEN) {
      if (siteBackendApi) return json({ ok: false, error: 'Site Backend is switched off.' }, 403);
      if (siteApiPage) return json({ ok: false, error: 'Site API is switched off.' }, 403, { 'cache-control': 'no-store' });
      return html(shell({
        title: 'Not available',
        theme, reduceMotion, settings: true, action: backAction(),
        body: `<p class="eyebrow">Off the field</p>
          <h1>Not available</h1>
          <p class="sub">This tool is switched off for your league right now.
             Whoever administers this site can turn it back on in Site Configuration.</p>`,
      }), 403);
    }

    const isDocument = /^\/apps\/[^/]+\/(index\.html)?$/.test(path);
    if (vis === VISIBILITY.ADMIN) {
      const unlocked = await hasToolUnlock(request, cfg, key);
      if (!unlocked) {
        if (siteBackendApi) return json({ ok: false, error: 'locked', locked: true }, 403);
        if (siteApiPage) return json({ ok: false, error: 'locked', locked: true }, 401, { 'cache-control': 'no-store' });
        if (isDocument) markPage(request, key, `${tool.name} (Admin Password prompt)`);
        return html(adminGatePage({ tool, theme, reduceMotion }), 200);
      }
    }
    if (siteBackendApi) return siteBackendRoute(request, env, cfg, url);
    if (siteApiPage) return siteApiPageRoute(request, env, cfg, url, ctx);
    if (isDocument) {
      markPage(request, key, tool.name);
      // A shared link being opened: its parameters say so, and nothing else about it is kept.
      if ((SHARE_PARAMS[key] || []).some((k) => url.searchParams.has(k))) {
        note(request, 'operation', `Opened a shared ${tool.name} link`, { page: key });
      }
    }
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('not found', { status: 404 });
}

/**
 * Events only a browser knows about: a share link written to the clipboard. One
 * allow-listed name each, nothing else accepted; the log object caps them at 60
 * a minute site-wide. Not an error channel.
 */
const CLIENT_EVENTS = {
  'share-trade': { text: 'Shared a Trade Analyzer link', page: 'trade-analyzer' },
  'share-fortune': { text: 'Shared a Fortune Teller link', page: 'fortune-teller' },
  // A copy or download is often served from the page's own copy, so only the browser knows it happened.
  'export-copy-full': { text: 'Exported league data (copy, full)', page: 'llm-export' },
  'export-copy-compact': { text: 'Exported league data (copy, compact)', page: 'llm-export' },
  'export-download-full': { text: 'Exported league data (download, full)', page: 'llm-export' },
  'export-download-compact': { text: 'Exported league data (download, compact)', page: 'llm-export' },
  // Site API: the key copied on the page, and a download taken. Never which key, never which rows.
  'api-key-copy': { text: 'Copied the Site API key', page: 'site-api' },
  'api-download': { text: 'Downloaded Site API data', page: 'site-api' },
  // A page that saw Cloudflare's daily limit page, reported once the site answered again (C6): the cutoff's record.
  'limit-seen': { text: 'A page saw Cloudflare’s daily limit and rested until 00:00 UTC', page: null, limit: true },
};

async function siteLogEvent(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
  const body = await readJson(request);
  const ev = CLIENT_EVENTS[body && body.name];
  if (!ev) return json({ ok: false, error: 'unknown event' }, 400);
  const trace = traceOf(request);
  if (!trace || !trace.record) return json({ ok: true, recorded: false });
  // At Protect the event waits for the isolate's next report rather than calling the log now (C5).
  if (!objectCallAllowed(env.BRAKE, 'client-event')) { note(request, 'operation', ev.text, { page: ev.page }); return json({ ok: true }); }
  const stub = logStub(env);
  if (stub) {
    const m = /(?:^|;\s*)eft_team=([^;]*)/.exec(request.headers.get('cookie') || '');
    const team = m && Number(decodeURIComponent(m[1])) > 0 ? Number(decodeURIComponent(m[1])) : null;
    try {
      const r = await stub.fetch('https://site-log/client', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: ev.text, page: ev.page, team, ...(ev.limit ? { limit: true, seenAt: Number(body.at) || null } : {}) }) });
      if (r.body && r.body.cancel) await r.body.cancel().catch(() => {});
    } catch { /* recording must never matter */ }
  }
  return json({ ok: true });
}

/**
 * Site Backend's data route. Lives under the tool's own path so the tool's unlock
 * cookie reaches it; the visibility checks above have already run. The log object
 * assembles the tab with its 30 s of CPU; this adds only what the Worker knows.
 */
export async function siteBackendRoute(request, env, cfg, url) {
  if (!env.SITE_LOG) return json({ ok: false, error: 'The site log is not available on this deployment.' }, 503);
  // At Protect the frontend calls no object but sign-in and the log's report, and Site Backend is assembled inside
  // the log object, so it rests until the day's use falls back (C5).
  if (!objectCallAllowed(env.BRAKE, 'site-backend')) return json({ ok: false, paused: 'protect', error: 'Site Backend rests while the site saves its daily allowance.' }, 503);
  const q = Object.fromEntries(url.searchParams);
  const now = seasonAt();
  const setupSeason = cfg.setupCompletedAt ? seasonAt(Date.parse(cfg.setupCompletedAt)) : now;
  const seasons = [];
  for (let y = now; y >= Math.max(FIRST_LOG_SEASON, Math.min(setupSeason, now)); y--) seasons.push(y);
  const asked = Number(q.season);
  const season = q.tab === 'activity' && seasons.includes(asked) ? asked : now;
  const vm = env.CF_VERSION_METADATA;
  const cf = request.cf || {};
  const facts = {
    build: BUILD_MARKER, version: displayVersion(), season, seasons,
    versionMetadata: vm ? { id: vm.id || null, tag: vm.tag || null, timestamp: vm.timestamp || null } : null,
    buildInfo: BUILD_INFO,
    bindings: Object.fromEntries(['CONFIG', 'DATA', 'ASSETS', 'COORDINATOR', 'THROTTLE', 'SCORE_TIMELINE', 'FORTUNE', 'SITE_LOG', 'CF_VERSION_METADATA']
      .map((b) => [b, Boolean(env[b])])),
    isolate: isolateFacts(),
    // Shown to the viewer about their own connection; the log never stores facts.
    viewer: { colo: cf.colo || null, httpProtocol: cf.httpProtocol || null, tlsVersion: cf.tlsVersion || null, rtt: cf.clientTcpRtt ?? null },
    devHooks: Boolean(env.DEV_TOKEN),
    // The viewer's own source, only to mark their alias You; redacted from every payload.
    you: cfg.sessionSecret ? await fingerprint(cfg.sessionSecret, clientAddress(request)).then((f) => (f ? f.id : null)).catch(() => null) : null,
    releaseItems: RELEASE_NOTE_ITEMS,
    needsHistoryRepull: NEEDS_HISTORY_REPULL,
  };
  const stub = logStub(env, season);
  const call = q.dataset
    ? stub.fetch('https://site-log/dataset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: q.dataset, facts }) })
    : stub.fetch('https://site-log/tab', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: q, facts }) });
  const r = await call;
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/**
 * Unlocking an admin-only tool.
 *
 * The Admin Password still has no persistent session and still arrives only in
 * a header — this verifies it exactly the way Site Configuration does. What is
 * different is that a tool is a page rather than a sequence of API calls, so
 * something has to carry the fact of a successful unlock across the document
 * request and the bundle and stylesheet that follow it. That is a signed,
 * HttpOnly cookie scoped to this one tool and valid for thirty minutes: short
 * enough that it is an unlock rather than an administrative session, and
 * narrow enough that it grants nothing anywhere else on the site.
 */
const TOOL_UNLOCK_TTL_SECONDS = 30 * 60;

const toolUnlockCookie = (key) => `eft_unlock_${key.replace(/[^a-z0-9-]/gi, '')}`;

async function hasToolUnlock(request, cfg, key) {
  if (!cfg.sessionSecret) return false;
  const token = readCookie(request, toolUnlockCookie(key));
  if (!token) return false;
  const session = await readSession(cfg.sessionSecret, token);
  return Boolean(session && session.s === `tool:${key}`);
}

async function handleToolUnlock(request, env, cfg) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
  const body = await readJson(request);
  const key = body && body.key;
  const tool = TOOLS.find((t) => t.key === key);
  if (!tool) return json({ ok: false, error: 'unknown tool' }, 404);
  if (visibilityOf(cfg, key) !== VISIBILITY.ADMIN) {
    return json({ ok: false, error: 'that tool is not restricted' }, 400);
  }
  // Header only, never the body — the same rule every admin call follows.
  const supplied = request.headers.get('x-admin-password') || '';
  if (!(await checkAdminPassword(cfg, supplied))) {
    note(request, 'admin', `Admin Password refused (${tool.name})`, { sev: 'warn', page: key });
    return json({ ok: false, error: 'That Admin Password is not right.' }, 401);
  }
  note(request, 'admin', `Unlocked ${tool.name}`, { page: key });
  const token = await createSession(cfg.sessionSecret, `tool:${key}`, TOOL_UNLOCK_TTL_SECONDS);
  return json({ ok: true, next: tool.href }, 200, {
    'set-cookie': `${toolUnlockCookie(key)}=${token}; Path=${tool.href}; HttpOnly; Secure; ` +
      `SameSite=Lax; Max-Age=${TOOL_UNLOCK_TTL_SECONDS}`,
  });
}

/** The prompt shown in place of a restricted tool. */
export function adminGatePage({ tool, theme, reduceMotion }) {
  // The shared gate (src/admingate.js): the same header, panel and note as Site Configuration's.
  const rail = adminGateRail(tool.name);
  const body = adminGateSection();
  const css = ADMIN_GATE_CSS;
  const js = `
var gm = document.getElementById('gateMsg');
async function unlock() {
  var el = document.getElementById('adminPw');
  if (!el.value) { gm.textContent = 'Enter the Admin Password.'; gm.className = 'msg err'; return; }
  gm.textContent = 'Checking'; gm.className = 'msg info';
  try {
    var res = await fetch('/api/tools/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': el.value },
      body: JSON.stringify({ key: ${JSON.stringify(tool.key)} })
    });
    var d = await res.json();
    if (!d.ok) { gm.textContent = d.error || 'That did not work.'; gm.className = 'msg err'; return; }
    /* Replace rather than push, so Back does not land on the gate again. */
    window.location.replace(d.next);
  } catch (e) {
    gm.textContent = 'Could not reach the server.'; gm.className = 'msg err';
  }
}
document.getElementById('unlock').addEventListener('click', unlock);
document.getElementById('adminPw').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') unlock();
});`;
  return shell({
    title: tool.name, theme, reduceMotion, rail, body,
    settings: true, stack: true, centred: true,
    action: backAction(), extraCss: css, extraJs: js,
    instructions: [
      ['01', 'This tool is restricted',
       'Someone set it to admin-only in Site Configuration. It stays listed on the dashboard so the league can see it exists.'],
      ['02', 'The Admin Password opens it',
       'The same one that opens Site Configuration. Whoever administers this site has it.'],
      ['03', 'The unlock is short-lived',
       'It lasts thirty minutes and applies only to this tool. Nothing else on the site is unlocked by it.'],
    ],
  });
}

function siteConfigTile() {
  return { key: SITE_CONFIG_TOOL.key, name: SITE_CONFIG_TOOL.name, description: SITE_CONFIG_TOOL.description, href: SITE_CONFIG_TOOL.href, adminOnly: true };
}

// ---------------------------------------------------------------- auth flows

async function handleSetupPasswords(request, env, cfg) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'Malformed request.' }, 400);
  if (setupCodeRequired() && !(await verifySetupCode(body.setupCode))) {
    return json({ ok: false, error: 'That setup code is not correct.' }, 403);
  }
  const result = await completePasswordSetup(env, cfg, {
    leaguePassword: body.leaguePassword,
    adminPassword: body.adminPassword,
  });
  if (!result.ok) return json({ ok: false, error: result.error }, result.status || 400);
  return json({ ok: true, next: '/' }, 200, { 'set-cookie': sessionCookie(result.token) });
}

async function handleLogin(request, env, cfg) {
  const gate = await throttleCheck(env, request);
  if (gate.blocked) {
    note(request, 'sign-in', gate.busy ? 'Sign-in asked to wait: the site is saving its daily allowance' : 'Sign-in blocked by the throttle', { sev: 'warn', page: 'signin' });
    return json({ ok: false, error: gate.busy ? 'The site is very busy right now. Try again in a minute.' : 'Too many attempts. Try again in a few minutes.' }, 429,
      { 'retry-after': String(gate.retryAfterSeconds || 600) });
  }
  const body = await readJson(request);
  if (!body || !body.password) {
    await throttleFail(env, request);
    return json({ ok: false, error: 'Enter the League Password.' }, 400);
  }
  if (!(await verifyPassword(body.password, cfg.leaguePasswordHash))) {
    const after = await throttleFail(env, request);
    note(request, 'sign-in', after.blocked ? 'Sign-in blocked by the throttle' : 'Sign-in failed', { sev: 'warn', page: 'signin' });
    return json({
      ok: false,
      error: after.blocked ? 'Too many attempts. Try again in a few minutes.' : 'That password was not correct.',
    }, after.blocked ? 429 : 401);
  }
  await throttleSucceed(env, request);
  note(request, 'sign-in', 'Signed in', { page: 'signin' });
  const ttl = sessionSecondsOf(cfg);
  const token = await createSession(cfg.sessionSecret, 'league', ttl);
  return json({ ok: true, next: '/' }, 200, { 'set-cookie': sessionCookie(token, ttl) });
}

// ---------------------------------------------------------------- wizard

/** Verify a league connection against ESPN before committing anything to KV. */
async function verifyLeague(cfg, { leagueId, leaguePrivate, espnS2, swid }) {
  const probe = {
    ...cfg, leagueId, leaguePrivate,
    espnS2: espnS2 || cfg.espnS2,
    swid: swid || cfg.swid,
  };
  const url =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${probe.season}` +
    `/segments/0/leagues/${leagueId}?view=mSettings`;
  const res = await fetchPart(probe, { url }, { auth: true });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: leaguePrivate
      ? 'ESPN refused those cookies. Check you copied espn_s2 and SWID exactly, without editing them.'
      : 'That league is private — switch the league type to private and add your ESPN cookies.' };
  }
  if (res.status === 404) return { ok: false, error: 'No league found with that ID for this season.' };
  if (!res.ok || !res.buffer) return { ok: false, error: `ESPN did not respond (${res.error || res.status}).` };

  try {
    const doc = JSON.parse(new TextDecoder().decode(res.buffer));
    const previous = (doc && doc.status && doc.status.previousSeasons) || [];
    return {
      ok: true,
      leagueName: (doc && doc.settings && doc.settings.name) || null,
      historySeasons: [...new Set(previous.map(Number))].filter(Number.isFinite).sort((a, b) => a - b),
    };
  } catch {
    return { ok: false, error: 'ESPN returned something unreadable. Try again in a moment.' };
  }
}

async function handleSetupLeague(request, env, cfg) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
  const body = await readJson(request);
  if (!body || !body.leagueId) return json({ ok: false, error: 'Enter your League ID.' }, 400);
  const leagueId = String(body.leagueId).trim();
  if (!/^\d+$/.test(leagueId)) return json({ ok: false, error: 'League ID should be digits only.' }, 400);

  const priv = Boolean(body.leaguePrivate);
  const espnS2 = body.espnS2 ? String(body.espnS2).trim() : '';
  const swid = body.swid ? String(body.swid).trim() : '';
  if (priv && (!espnS2 || !swid)) {
    return json({ ok: false, error: 'A private league needs both the espn_s2 and SWID cookies.' }, 400);
  }
  if (priv && !/^\{[0-9A-Fa-f-]{36}\}$/.test(swid)) {
    return json({ ok: false, error: 'SWID should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}, braces included.' }, 400);
  }

  const verified = await verifyLeague(cfg, { leagueId, leaguePrivate: priv, espnS2, swid });
  if (!verified.ok) return json({ ok: false, error: verified.error }, 400);

  const patch = { leagueId, leaguePrivate: priv };
  if (espnS2) patch.espnS2 = espnS2;
  if (swid) patch.swid = swid;
  if (verified.historySeasons.length) patch.historySeasons = verified.historySeasons;
  await saveConfig(env, patch);

  return json({ ok: true, leagueName: verified.leagueName, historySeasons: verified.historySeasons });
}

async function handleSetupTools(request, env, cfg) {
  if (request.method === 'GET') return json({ ok: true, tools: describeTools(cfg) });
  const body = await readJson(request);
  const visibility = {};
  if (body && body.visibility && typeof body.visibility === 'object') {
    // One state per tool; a tool the wizard did not mention takes the registry's default.
    const allowed = Object.values(VISIBILITY);
    for (const t of TOOLS) {
      const v = body.visibility[t.key];
      if (v !== undefined && !allowed.includes(v)) return json({ ok: false, error: `Unknown visibility "${v}".` }, 400);
      visibility[t.key] = v || t.defaultVisibility;
    }
  } else {
    // The older form: the tools picked, each at its default (Site Backend admin-only), the rest hidden.
    const picked = new Set((body && body.tools) || []);
    for (const t of TOOLS) visibility[t.key] = picked.has(t.key) ? t.defaultVisibility : 'hidden';
  }
  // Site Backend never counts toward this: it is not a league tool.
  if (!LEAGUE_TOOLS.some((t) => visibility[t.key] === 'visible')) {
    return json({ ok: false, error: 'Keep at least one tool visible to your league.' }, 400);
  }
  // Deliberately does NOT mark setup complete. Doing so here was what broke the
  // wizard: `setupCompletedAt` flips isSetupFinished, isSetupFinished un-routes
  // /api/setup/*, and the very next thing the wizard does is call
  // /api/setup/history-batch — which answered 404 and stranded the page with no
  // way forward or back. Completion is now claimed by /api/setup/finish, after
  // the last step has either run or been skipped.
  await saveConfig(env, { toolVisibility: visibility });
  return json({ ok: true, tools: describeTools(await loadConfig(env, { fresh: true })) });
}

/** The wizard's last act: mark setup complete so the site opens normally. */
async function handleSetupFinish(request, env, cfg) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
  if (!cfg.leagueId) return json({ ok: false, error: 'Connect your league first.' }, 400);
  // Site API's key exists from the moment setup finishes: generation 1 starts now.
  const sa = cfg.siteApi && cfg.siteApi.gen ? cfg.siteApi : startedKey(cfg.siteApi || normaliseSiteApi(null));
  await saveConfig(env, { setupCompletedAt: new Date().toISOString(), siteApi: sa });
  // Recording starts here, so this request is its first entry.
  const trace = traceOf(request);
  if (trace) trace.record = true;
  note(request, 'admin', 'Setup finished', { page: 'wizard' });
  return json({ ok: true });
}

/**
 * Fetch every dataset once. Runs during setup and can be re-run from Site
 * Configuration; see prime.js for why an on-demand platform still needs it.
 */
async function handlePrimeBatch(request, env, cfg) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
  if (!cfg.leagueId) return json({ ok: false, error: 'Connect your league first.' }, 400);
  const body = await readJson(request);
  return json(await runPrimeBatch(env, cfg, { restart: Boolean(body && body.restart) }));
}

async function handleHistoryBatch(request, env, cfg) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
  const body = await readJson(request);
  return json(await runBatch(env, cfg, { restart: Boolean(body && body.restart) }));
}

// ---------------------------------------------------------------- admin

/**
 * Admin actions.
 *
 * The Admin Password arrives only in the x-admin-password header, never in the
 * body — the body carries new values, and mixing the two would make "change my
 * admin password" ambiguous with "authenticate as admin". Verified afresh on
 * every single call: there is no admin session by design.
 */
/** Site Configuration's Site API facts, after any replacement that is due (a page view counts as a request). */
async function siteApiFacts(env, cfg, { lazy = true } = {}) {
  let c = cfg;
  if (lazy && isSetupFinished(cfg)) { try { c = await apiSettings(env, Date.now(), { fresh: true }); } catch { c = cfg; } }
  return adminFacts(c.sessionSecret, c.siteApi);
}

async function handleAdmin(request, env, cfg, path) {
  const supplied = request.headers.get('x-admin-password');
  const body = request.method === 'POST' ? (await readJson(request)) || {} : {};

  const gate = await throttleCheck(env, request);
  if (gate.blocked) return json({ ok: false, error: gate.busy ? 'The site is very busy right now. Try again in a minute.' : 'Too many attempts. Try again in a few minutes.' }, 429);

  if (!(await checkAdminPassword(cfg, supplied))) {
    await throttleFail(env, request);
    // A load of Site Configuration asks before any password is typed; only a real attempt is noted.
    if (supplied) note(request, 'admin', 'Admin Password refused (Site Configuration)', { sev: 'warn', page: 'config' });
    return json({ ok: false, error: 'Admin Password required.' }, 403);
  }
  await throttleSucceed(env, request);
  const stamp = () => new Date().toISOString();

  if (path === '/api/admin/verify') {
    note(request, 'admin', 'Admin Password accepted (Site Configuration)', { page: 'config' });
    return json({ ok: true, verified: true });
  }

  if (path === '/api/admin/config') {
    return json({
      ok: true,
      config: describeConfig(cfg),
      tools: describeTools(cfg),
      order: describeTileOrder(cfg),
      siteApi: await siteApiFacts(env, cfg),
      history: jobStatus(await readJob(env)),
      // Reported alongside history for the same reason: the panel has to be
      // able to say what state it is in when the page opens, not only while a
      // run happens to be in progress.
      prime: await primeStatus(env),
    });
  }

  if (path === '/api/admin/cookies') {
    const espnS2 = (body.espnS2 || '').trim();
    const swid = (body.swid || '').trim();
    if (!espnS2 && !swid) return json({ ok: false, error: 'Enter at least one value.' }, 400);
    if (swid && !/^\{[0-9A-Fa-f-]{36}\}$/.test(swid)) {
      return json({ ok: false, error: 'SWID should look like {XXXXXXXX-...}, braces included.' }, 400);
    }
    const verified = await verifyLeague(cfg, {
      leagueId: cfg.leagueId, leaguePrivate: cfg.leaguePrivate,
      espnS2: espnS2 || cfg.espnS2, swid: swid || cfg.swid,
    });
    if (!verified.ok) return json({ ok: false, error: verified.error }, 400);

    const patch = { stamps: { espnCookies: stamp() } };
    if (espnS2) patch.espnS2 = espnS2;
    if (swid) patch.swid = swid;
    const saved = await saveConfig(env, patch);
    note(request, 'admin', `ESPN cookies updated (${[espnS2 && 'espn_s2', swid && 'SWID'].filter(Boolean).join(' and ')})`, { page: 'config' });
    return json({
      ok: true, config: describeConfig(saved), tools: describeTools(saved),
      history: jobStatus(await readJob(env)),
    });
  }

  if (path === '/api/admin/passwords') {
    const lp = body.leaguePassword || '';
    const ap = body.adminPassword || '';
    const patch = {};
    if (lp) {
      if (lp.length < 8) return json({ ok: false, error: 'League Password must be at least 8 characters.' }, 400);
      patch.leaguePasswordHash = await hashPassword(lp);
    }
    if (ap) {
      if (ap.length < 8) return json({ ok: false, error: 'Admin Password must be at least 8 characters.' }, 400);
      if (lp && lp === ap) return json({ ok: false, error: 'The two passwords must be different.' }, 400);
      patch.adminPasswordHash = await hashPassword(ap);
    }
    if (!Object.keys(patch).length) return json({ ok: false, error: 'Enter at least one new password.' }, 400);
    // A changed League Password usually means someone is being locked out, so the Site API key is replaced
    // with it, at once and with no grace period.
    const saNow = normaliseSiteApi(cfg.siteApi);
    if (lp && saNow.gen) patch.siteApi = replacedKey(saNow, Date.now(), { grace: false, how: 'password' });
    patch.stamps = {};
    // Everyone signed in under the old League Password is signed out, however long their sign-in was set to last.
    if (lp) patch.sessionsFrom = Math.floor(Date.now() / 1000);
    if (lp) patch.stamps.leaguePassword = stamp();
    if (ap) patch.stamps.adminPassword = stamp();
    const savedPw = await saveConfig(env, patch);
    if (lp) note(request, 'admin', 'League Password changed', { page: 'config' });
    if (ap) note(request, 'admin', 'Admin Password changed', { page: 'config' });
    if (patch.siteApi) {
      forgetApiSettings();
      note(request, 'admin', 'Site API key replaced with the League Password; the old key stopped', { page: 'site-api' });
    }
    let keep = null;
    if (lp) { const ttl = sessionSecondsOf(savedPw); keep = { 'set-cookie': sessionCookie(await createSession(savedPw.sessionSecret, 'league', ttl), ttl) }; }
    return json({ ok: true, keyReplaced: Boolean(patch.siteApi), siteApi: await siteApiFacts(env, savedPw, { lazy: false }) }, 200, keep || {});
  }

  if (path === '/api/admin/site-api-members') {
    // High activity's likely members, for the aliases on screen: the only answer that ever carries one. It changes
    // nothing; the page holds what it gets in memory and drops it when it is left.
    if (!env.SITE_LOG) return json({ ok: false, error: 'The site log is not available on this deployment.' }, 503);
    const aliases = (Array.isArray(body.aliases) ? body.aliases : []).map(String).filter((a) => /^IPv[46]:\d{1,5}$/.test(a)).slice(0, 200);
    const r = await logStub(env).fetch('https://site-log/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aliases }) });
    const j = await r.json().catch(() => ({}));
    note(request, 'admin', `Likely members shown on Site Backend (${aliases.length} ${aliases.length === 1 ? 'source' : 'sources'})`, { page: 'site-backend' });
    return json({ ok: true, members: (j && j.members) || {} }, 200, { 'cache-control': 'no-store' });
  }

  if (path === '/api/admin/site-api') {
    // The Site API panel: the switch, replace now (gently, or stopping the old key), how often it is
    // replaced, and whether the key may travel in an address. Answers with the panel's facts, never the key.
    const action = String(body.action || '');
    if (!['on', 'off', 'replace', 'settings'].includes(action)) return json({ ok: false, error: 'unknown action' }, 400);
    const now = Date.now();
    let sa = normaliseSiteApi(cfg.siteApi);
    if (!sa.gen) sa = startedKey(sa, now);
    const said = [];
    let changed = null;
    if (action === 'on' || action === 'off') {
      sa = { ...sa, on: action === 'on' };
      said.push(action === 'on' ? 'Site API switched on' : 'Site API switched off');
    } else if (action === 'replace') {
      const stop = body.stop === true;
      sa = replacedKey(sa, now, { grace: !stop, how: stop ? 'stop' : 'manual' });
      changed = stop ? 'stopped' : 'grace';
      said.push(stop ? 'Site API key replaced and the old key stopped' : 'Site API key replaced; the old one works for 7 more days');
    } else {
      if ('interval' in body) {
        const iv = body.interval === 'season' ? 'season' : Number(body.interval);
        if (!KEY_INTERVALS.includes(iv)) return json({ ok: false, error: 'Choose 30, 60, 90 or 180 days, or Season End.' }, 400);
        sa = { ...sa, interval: iv };
        said.push(`Site API key now replaced ${iv === 'season' ? 'at Season End' : `every ${iv} days`}`);
        // A changed interval moves the due date, never the key; a date already passed replaces it with the usual grace.
        const due = dueChange(sa, now);
        if (due) { sa = due; changed = 'due'; said.push('Site API key replaced: its new due date had already passed'); }
      }
      if ('inAddress' in body) {
        sa = { ...sa, inAddress: body.inAddress !== false };
        said.push(sa.inAddress ? 'Site API key allowed in the address' : 'Site API key refused in the address: header only');
      }
      if (!said.length) return json({ ok: false, error: 'Nothing to change.' }, 400);
    }
    const saved = await saveConfig(env, { siteApi: sa, stamps: { siteApi: stamp() } });
    forgetApiSettings();
    for (const text of said) note(request, 'admin', text, { page: 'site-api' });
    return json({ ok: true, action, changed, siteApi: await siteApiFacts(env, saved, { lazy: false }) });
  }

  if (path === '/api/admin/fortune-teller') {
    // Switch Fortune Teller on or off, check now, or rebuild. The setting is handed to the
    // pipeline directly: its own config cache may not see the save for a few seconds.
    const action = String(body.action || '');
    if (!['enable', 'disable', 'check', 'rebuild'].includes(action)) return json({ ok: false, error: 'unknown action' }, 400);
    if (action === 'enable' || action === 'disable') await saveConfig(env, { fortuneTeller: { enabled: action === 'enable', changedAt: new Date().toISOString() } });
    note(request, 'admin', { enable: 'Fortune Teller switched on', disable: 'Fortune Teller switched off', check: 'Fortune Teller checked by hand', rebuild: 'Fortune Teller rebuild asked for' }[action], { page: 'fortune-teller' });
    let pipeline = null;
    if (env.FORTUNE) {
      const stub = env.FORTUNE.get(env.FORTUNE.idFromName('fortune-teller'));
      const now = action === 'enable' ? '&enabled=1' : action === 'disable' ? '&enabled=0' : '';
      const r = await stub.fetch(`https://ft/pipeline?reason=admin-${action}${action === 'rebuild' ? '&force=1' : ''}${now}`);
      pipeline = r.ok ? (await r.json()).pipeline : null;
    }
    const after = await loadConfig(env, { fresh: true });
    const enabledNow = action === 'enable' ? true : action === 'disable' ? false : Boolean(after.fortuneTeller && after.fortuneTeller.enabled);
    return json({ ok: true, enabled: enabledNow, pipeline });
  }

  if (path === '/api/admin/trade-weights') {
    const next = {};
    for (const row of TRADE_ROWS) {
      const raw = body.weights && body.weights[row.id];
      if (raw === undefined || raw === null || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 2) {
        return json({ ok: false, error: `${row.id} must be between 0% and 200%` }, 400);
      }
      // Rounded to the step the panel offers, so a stored value always matches
      // a position the slider can actually return to.
      const snapped = Math.round(value * 20) / 20;
      // Only what differs from the shipped default is kept.
      if (Math.abs(snapped - row.w) > 1e-9) next[row.id] = snapped;
    }
    const saved = await saveConfig(env, { tradeWeights: next, stamps: { tradeWeights: stamp() } });
    const moved = Object.keys(next).length;
    note(request, 'admin', `Trade weighting changed: ${moved} of ${TRADE_ROWS.length} rows away from the default`, { page: 'trade-analyzer' });
    return json({ ok: true, tradeWeights: saved.tradeWeights || {} });
  }

  if (path === '/api/admin/tool-visibility') {
    const result = applyVisibility(cfg, body.tool, body.visibility);
    if (!result.ok) return json({ ok: false, error: result.error }, 400);
    const saved = await saveConfig(env, { toolVisibility: result.toolVisibility, stamps: { toolVisibility: { [body.tool]: stamp() } } });
    const t = TOOLS.find((x) => x.key === body.tool);
    note(request, 'admin', `Tool visibility changed: ${t ? t.name : body.tool} → ${body.visibility === 'admin' ? 'admin-only' : body.visibility}`, { page: body.tool });
    return json({ ok: true, tools: describeTools(saved) });
  }

  if (path === '/api/admin/session-length') {
    // How long a League Password sign-in lasts: one stop of SESSION_STOPS. Takes effect for the next sign-in; the
    // sign-ins already made keep the length they were given.
    if (!SESSION_STOPS.includes(body.hours)) return json({ ok: false, error: 'Choose one of the lengths on the slider.' }, 400);
    const saved = await saveConfig(env, { sessionHours: body.hours === 8 ? null : body.hours, stamps: { sessionHours: stamp() } });
    note(request, 'admin', `Sign-in length changed: ${sessionWords(body.hours)}`, { page: 'config' });
    return json({ ok: true, hours: sessionHoursOf(saved) });
  }

  if (path === '/api/admin/tool-order') {
    // The home page's tile order. A full list of the tiles, each once; `reset` returns to the default.
    let next = null;
    if (!body.reset) {
      const order = Array.isArray(body.order) ? body.order : null;
      const known = new Set(defaultTileOrder());
      if (!order || !order.length || order.some((k) => !known.has(k)) || new Set(order).size !== order.length) {
        return json({ ok: false, error: 'Send each tile once, by its key.' }, 400);
      }
      next = normaliseTileOrder(order);
      // An order that matches the default is stored as the default, so later tools keep their shipped place.
      if (next.join() === defaultTileOrder().join()) next = null;
    }
    const saved = await saveConfig(env, { toolOrder: next, stamps: { toolOrder: stamp() } });
    note(request, 'admin', next ? 'Home page tool order changed' : 'Home page tool order reset to the default', { page: 'config' });
    return json({ ok: true, order: describeTileOrder(saved) });
  }

  if (path === '/api/admin/history-batch') {
    if (body.restart) note(request, 'admin', 'Box-score history re-pull started', { page: 'config' });
    const out = await runBatch(env, cfg, { restart: Boolean(body.restart) });
    if (out && out.complete && !body.restart) note(request, 'admin', 'Box-score history re-pull finished', { page: 'config' });
    return json(out);
  }

  if (path === '/api/admin/prime-batch') {
    if (body.restart) note(request, 'admin', 'League data re-pull started', { page: 'config' });
    const out = await runPrimeBatch(env, cfg, { restart: Boolean(body.restart) });
    if (out && out.complete && !body.restart) note(request, 'admin', `League data re-pull finished${out.failures && out.failures.length ? ` with ${out.failures.length} failures` : ''}`, { page: 'config' });
    return json(out);
  }

  return json({ ok: false, error: `no admin route for ${path}` }, 404);
}

// ---------------------------------------------------------------- data serving

// ---------------------------------------------------------------- live matchups

/**
 * Everything the Live Matchups tool reads.
 *
 * Two routes, because they have genuinely different lifetimes: the current
 * week is a 15-second snapshot served through the ordinary ensure/revalidate
 * path, while a completed week is immutable and is fetched exactly once ever.
 */
async function handleLive(env, cfg, rest, url, ctx) {
  if (rest === 'week') return liveWeek(env, cfg, url, ctx);
  if (rest === 'timeline') return liveTimeline(env, url, ctx);
  if (rest === 'h2h') return liveH2h(env, ctx);
  return json({ ok: false, error: `no live route for ${rest}` }, 404);
}

/**
 * One week of matchup detail.
 *
 * A completed week is pulled from ESPN once, reduced, and stored beside the
 * current week's digest under a `w<N>` part. Nothing re-fetches it afterwards,
 * because a played week cannot change — which is also why it is deliberately
 * not in the standard sweep: a *future* week answers with a valid but empty
 * payload, and caching that under a manual TTL would freeze the week as
 * permanently unplayed.
 *
 * The backfill is not routed through the coordinator. The coordinator refreshes
 * whole datasets by key and has no notion of a part argument, and teaching it
 * one would mean changing shared infrastructure every existing surface depends
 * on. The cost of not coalescing here is that two people opening the same old
 * week in the same second both fetch it — an idempotent write of identical
 * bytes, on a path that runs at most once per week per deployment.
 */
async function liveWeek(env, cfg, url, ctx) {
  const out = await liveWeekPayload(env, cfg, Number(url.searchParams.get('w') || 0), ctx);
  // Once a minute the page's 15-second poll also asks for the week's score history (?timeline=1), answered here in
  // the same response, so following a game takes one request where it took two.
  if (url.searchParams.get('timeline') === '1' && objectCallAllowed(env.BRAKE, 'timeline') && out.status === 200 && out.body && out.body.live && out.body.digest && out.body.digest.season) {
    const season = String(out.body.digest.season), week = out.body.week;
    const t = await timelineRead(env, season, week).catch(() => null);
    if (t) out.body = { ...out.body, timeline: { season, week, rows: t.rows || [], events: t.events || [], lastTick: t.lastTick || null } };
  }
  return json(out.body, out.status);
}

/**
 * One week of Live Matchups, as the route serves it. Exported so the dev
 * preview shows exactly what the page would, rebuilds included.
 */
export async function liveWeekPayload(env, cfg, asked, ctx) {
  const reply = (body, status = 200) => ({ body, status });
  const current = await ensureDataset(env, 'live_scoring_digest', ctx);
  let live = null;
  if (current) {
    try { live = await current.json(); } catch { live = null; }
  }
  if (!live) {
    // Written for whoever is looking at it: the cause is almost always that
    // the league pull has not run on this site yet.
    return reply({ ok: false, error: 'League data has not been pulled yet, so there is nothing to show. '
      + 'Whoever administers this site can start it from Site Configuration.' }, 503);
  }

  const currentWeek = Number(live.matchupPeriod || 1);
  const week = Number.isFinite(asked) && asked > 0 ? asked : currentWeek;

  if (week === currentWeek) {
    return reply({ ok: true, week, current: currentWeek, live: true, digest: live });
  }
  if (week > currentWeek) {
    return reply({ ok: false, error: 'that week has not been played yet', current: currentWeek }, 400);
  }

  /* A past week is built once and kept. One built before the fixture fix took
     the scoreboard's week, which by then was the next one, so it is rebuilt
     rather than served; so is one whose schedule had not yet caught up with a
     final score. Everything else is served as stored. */
  const part = `w${week}`;
  const cached = await getPart(env, 'live_scoring_digest', part);
  if (cached) {
    try {
      const stored = await cached.json();
      const b = stored && stored.board;
      if (b && b.version === 2 && b.complete) {
        return reply({ ok: true, week, current: currentWeek, live: false, digest: stored });
      }
    } catch { /* fall through and rebuild */ }
  }

  const spec = PARAM_DATASETS.live_scoring_week;
  const res = await fetchPart(cfg, { url: spec.url(cfg, week) }, { auth: true });
  if (!res.ok || !res.buffer) {
    return reply({ ok: false, error: `ESPN did not return week ${week}`, status: res.status }, 502);
  }

  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(res.buffer));
  } catch {
    return reply({ ok: false, error: `week ${week} came back unreadable` }, 502);
  }

  // The same joins the live digest uses, resolved the same way.
  const sources = {};
  for (const key of ['league_teams', 'standings_digest', 'scoreboard_digest', 'bye_weeks', 'league_settings']) {
    const obj = await ensureDataset(env, key, ctx);
    if (obj) {
      try { sources[key] = await obj.json(); } catch { /* leave absent */ }
    }
  }

  const digest = buildLiveScoringDigest(doc, { sources, week, matchupPeriod: week, past: true });
  const body = new TextEncoder().encode(JSON.stringify(digest));
  await putPart(env, 'live_scoring_digest', part, body.buffer, {
    fetchedAt: new Date().toISOString(),
    derivedFrom: 'live_scoring_week',
    week: String(week),
    bytes: body.byteLength,
  });

  return reply({ ok: true, week, current: currentWeek, live: false, built: true, digest });
}

/**
 * Every pair's all-time record.
 *
 * Served whole rather than per pair: the digest is a few tens of kilobytes for
 * a decade of a ten-team league, and the tool needs a different pair for every
 * card on the page. Fetching it once beats five round trips.
 */
async function liveH2h(env, ctx) {
  const obj = await ensureDataset(env, 'h2h_digest', ctx);
  if (!obj) {
    return json({ ok: true, ready: false, pairs: {}, seasons: 0 });
  }
  try {
    const digest = await obj.json();
    return json({ ok: true, ready: true, ...digest });
  } catch {
    return json({ ok: true, ready: false, pairs: {}, seasons: 0 });
  }
}

/**
 * The whole record book in one read.
 *
 * Both digests are served together because the page needs both on first paint
 * and they are rebuilt in the same pass: splitting them into two endpoints
 * would double the round trips to show one screen. Neither touches ESPN on this
 * path — the archive is immutable and both are refreshed on the slow poll.
 *
 * An absent digest is not an error. A league that has never played a season has
 * nothing to put here, and the tool renders its own designed empty state for
 * that rather than an apology.
 */
/**
 * The Trade Analyzer's board.
 *
 * One digest, resolved through the coordinator like every other read path. The
 * evaluation itself is not here and deliberately so: the sliders recompute a
 * weighted sum on every drag and the rebalancing pass re-scores roughly a
 * hundred neighbouring trades each time, which belongs in the browser holding
 * the data rather than in a round trip per pixel.
 */
async function tradeAnalyzer(env, ctx) {
  const empty = { ok: true, ready: false, teams: [], pending: [] };
  const obj = await ensureDataset(env, 'trade_digest', ctx);
  if (!obj) return json(empty);
  let digest = null;
  try { digest = await obj.json(); } catch { digest = null; }
  if (!digest || !Array.isArray(digest.teams) || !digest.teams.length) return json(empty);
  /* The league's own weighting, if it has set one. Sent alongside the board
     rather than baked into it: the digest is shared by every member and this is
     a setting, not data. */
  const cfg = await loadConfig(env);
  return json({ ok: true, ready: true, adminWeights: cfg.tradeWeights || null, ...digest });
}

/**
 * The LLM Data Export's document.
 *
 * One league-wide digest, served as built. The reader's team and the compact
 * form are applied in the browser, so this answer is the same for every member.
 */
async function llmExport(env, ctx, url) {
  /* Two speeds.
   *
   * A page load takes what is stored and refreshes behind it, because waiting
   * several seconds on a rebuild to look at a page is the wrong trade. Copy and
   * Download ask with ?fresh=1 and wait, because a file handed to an assistant
   * has to describe the league as it stands. */
  const wantFresh = url && url.searchParams.get('fresh') === '1';
  return llmExportRoute(env, ctx, wantFresh);
}

async function llmExportRoute(env, ctx, wantFresh = false) {
  /* The stored export, refreshed behind the answer either way.
   *
   * A full rebuild reads every roster, the free-agent pool and half a dozen
   * digests, and takes several seconds; nobody should wait that for a page.
   * When a file is being handed over, this week's scoring — the only thing
   * that moves minute to minute — is laid over the stored copy instead, which
   * costs a moment. */
  // A copy or download waits for a stale export's rebuild; a page load is answered at once and rebuilds behind.
  const digest = await llmExportDigest(env, wantFresh ? null : ctx);
  const sim = await simOdds(env);
  if (!wantFresh || !digest) return json(llmExportPayload(digest, sim));
  const obj = await ensureDataset(env, 'live_scoring_digest', ctx);
  let live = null;
  if (obj) {
    try { live = await obj.json(); } catch { live = null; }
  }
  return json(llmExportPayload(applyLiveScoring(digest, live), sim));
}

/**
 * The stored export. With no request context the rebuild is awaited; with one
 * it happens behind the answer.
 */
export async function llmExportDigest(env, ctx = null) {
  const obj = await ensureDataset(env, 'llm_export_digest', ctx);
  if (!obj) return null;
  try { return await obj.json(); } catch { return null; }
}

async function hallOfFame(env, ctx) {
  const empty = { ok: true, ready: false, rows: [], pairs: {}, records: {}, champions: [], seasonMeta: {} };
  const bookObj = await ensureDataset(env, 'league_history_digest', ctx);
  if (!bookObj) return json(empty);

  let book = null;
  try { book = await bookObj.json(); } catch { book = null; }
  if (!book || !Array.isArray(book.rows)) return json(empty);

  let pairs = {};
  const pairObj = await ensureDataset(env, 'h2h_full_digest', ctx);
  if (pairObj) {
    try { pairs = (await pairObj.json()).pairs || {}; } catch { pairs = {}; }
  }

  return json({ ok: true, ready: true, ...book, pairs });
}

/**
 * The stored score/win-probability history for one week.
 *
 * Read-only: rows are written by the Cron Trigger, never by a page view, which
 * is the whole reason the timeline exists as its own Durable Object rather than
 * as another derived dataset.
 */
async function liveTimeline(env, url, ctx) {
  const season = url.searchParams.get('season') || '';
  const week = Number(url.searchParams.get('w') || 0);
  if (!season || !week) {
    return json({ ok: false, error: 'season and w are required' }, 400);
  }
  // At Protect the page keeps the history it has (the timeline lives in an object, and the frontend calls none).
  if (!objectCallAllowed(env.BRAKE, 'timeline')) return json({ ok: false, paused: true, error: 'The site is saving its daily allowance; the score history will catch up.' }, 503);
  const out = await timelineRead(env, season, week);
  return json({
    ok: true, season, week,
    count: out.count || 0, rows: out.rows || [],
    events: out.events || [],
    // When sampling last ran, which is not the same as when a value last
    // changed. A chart needs it to know a flat line runs to now.
    lastTick: out.lastTick || null,
  });
}

/**
 * Serve a dataset, stale-while-revalidate.
 *
 * A stale copy is served immediately and the refresh runs after the response
 * via waitUntil. Blocking on ESPN would put a fresh network round trip in front
 * of nearly every page load, because the liveliest datasets have a 15-second
 * freshness window — the page would feel broken while it waited. Only a
 * complete cache miss blocks, since there is nothing to show otherwise.
 */
/**
 * Several of Draft Helper's datasets in one answer: ?k=<key>&e=<tag held>&k=<key>&e=… . Each is judged exactly as
 * /api/data/<key> judges it (refreshed behind the answer when stale, never forced); one the page already holds,
 * named by its tag, comes back as { etag, same: true } with no body, the rest as { etag, data }. The stored text
 * is passed through as it is, never parsed.
 */
async function dataBatch(env, cfg, url, ctx) {
  const keys = url.searchParams.getAll('k');
  const tags = url.searchParams.getAll('e');
  if (!keys.length || keys.length > DATA_ROUTE_DATASETS.size || new Set(keys).size !== keys.length || keys.some((k) => !DATA_ROUTE_DATASETS.has(k))) {
    return json({ ok: false, error: 'ask for one or more of Draft Helper’s datasets, each once' }, 400);
  }
  const one = async (key, held) => {
    const dataset = getDataset(key);
    let head = await headPart(env, key, 'main');
    if (!brakeAllowsRefresh(env, dataset, Boolean(head))) {
      /* the brake (C5): what is stored is served as it is */
    } else if (!head) {
      await coordinatorRefresh(env, key, false);
      head = await headPart(env, key, 'main');
    } else if (!isFresh(head.uploaded, dataset.ttl)) {
      const task = coordinatorRefresh(env, key, false);
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
      else await task;
    }
    if (!head) return `${JSON.stringify(key)}:{"ok":false}`;
    if (held && head.httpEtag && held === head.httpEtag) return `${JSON.stringify(key)}:{"etag":${JSON.stringify(head.httpEtag)},"same":true}`;
    const obj = await getPart(env, key, 'main');
    if (!obj) return `${JSON.stringify(key)}:{"ok":false}`;
    return `${JSON.stringify(key)}:{"etag":${JSON.stringify(obj.httpEtag || '')},"data":${await obj.text()}}`;
  };
  const parts = await Promise.all(keys.map((k, i) => one(k, tags[i] || '')));
  return new Response(`{"ok":true,"sets":{${parts.join(',')}}}`, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function serveDataset(env, cfg, key, part, url, ctx, request = null) {
  const dataset = getDataset(key);
  if (!dataset) return json({ ok: false, error: `unknown dataset "${key}"` }, 404);

  const known = new Set(dataset.parts(cfg).map((p) => p.part));
  if (!known.has(part)) {
    return json({ ok: false, error: `unknown part "${part}"` }, 404);
  }

  // A member cannot force a refresh: that would put ESPN one request away from anyone
  // with the League Password. Freshness is the dataset's own interval; forcing is for dev.
  let head = await headPart(env, key, part);
  let refreshed = null;
  let revalidating = false;

  if (!brakeAllowsRefresh(env, dataset, Boolean(head))) {
    /* the brake (C5): what is stored is served as it is */
  } else if (!head) {
    // Nothing cached: this one has to wait.
    refreshed = await coordinatorRefresh(env, key, false);
    head = await headPart(env, key, part);
  } else if (!isFresh(head.uploaded, dataset.ttl)) {
    // Stale but present: answer now, refresh behind the response.
    revalidating = true;
    const task = coordinatorRefresh(env, key, false);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
    else await task;
  }

  if (!head) {
    return json({ ok: false, error: 'dataset unavailable and no cached copy exists', refresh: refreshed ? { ok: Boolean(refreshed.ok) } : null }, 502);
  }

  // A poll that already holds this copy is told so, with no body: one R2 head, no transfer.
  const held = request && request.headers.get('if-none-match');
  if (held && head.httpEtag && held === head.httpEtag) {
    return new Response(null, { status: 304, headers: { etag: head.httpEtag, 'cache-control': 'no-store', 'x-dataset': key } });
  }

  const obj = await getPart(env, key, part);
  if (!obj) return json({ ok: false, error: 'object vanished between head and get' }, 502);

  return new Response(obj.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      etag: obj.httpEtag,
      'x-dataset': key,
      'x-dataset-part': part,
      'x-data-age': String(ageSeconds(head.uploaded)),
      'x-data-ttl': String(dataset.ttl),
      'x-data-stale': isFresh(head.uploaded, dataset.ttl) ? 'false' : 'true',
      'x-data-revalidating': revalidating ? 'true' : 'false',
      'x-data-fetched-at': (head.customMetadata && head.customMetadata.fetchedAt) || '',
    },
  });
}

/**
 * Everything the dashboard polls, in one round trip.
 *
 * Reads only the derived digests, never the raw payloads. The matchup payload
 * alone is 1.4MB and this endpoint is polled every 15 seconds; parsing that on
 * a 10ms CPU budget is not viable, so the reduction happens once at refresh
 * time and is cached in R2.
 */
/**
 * The home page's poll. Every 90 seconds it also asks for the board (?board=1&team=…), which is then answered in
 * the same response, so the page makes one request where it used to make two.
 */
async function dashboardStatus(env, ctx, url) {
  if (!url || url.searchParams.get('board') !== '1') return json(await dashboardPayload(env, ctx));
  const [status, board] = await Promise.all([
    dashboardPayload(env, ctx),
    boardPayload(env, ctx, url.searchParams.get('team')).catch(() => ({ ok: false })),
  ]);
  return json({ ...status, board });
}

/**
 * Which matchups are finished, by team.
 *
 * ESPN does not set a winner until the scoring period closes, so a fixture
 * whose every player finished on Sunday evening still reports UNDECIDED for the
 * best part of two days. Reading `winner` therefore calls a settled matchup
 * live, which is what the home page was doing while Live Matchups — which
 * treats a matchup as over once no starter has a game left to play — correctly
 * showed it as final. Both now read the same field, so the same fixture cannot
 * be described two ways on two surfaces.
 */
/**
 * A settled matchup has points in it.
 *
 * At a period rollover every player's game status still resolves to last
 * week's finished NFL fixtures, so the live digest can report a week nobody has
 * played as complete. A fantasy matchup where neither side has scored anything
 * has not been played, whatever the game states say, and calling it final
 * produced a nil-nil tie on the home page for a week that had not started.
 */
function settled(state, a, b) {
  if (state !== 'final') return state;
  return ((a || 0) > 0 || (b || 0) > 0) ? 'final' : 'pre';
}

function matchupStates(live, period) {
  const byTeam = new Map();
  for (const g of (live && live.games) || []) {
    /* Only the week being asked about. The live digest lags a period rollover
       by one refresh, and without this guard last week's finished states were
       joined onto this week's fixtures — a matchup nobody had played yet read
       as final, nil-nil, tied. */
    if (period != null && g.period != null && g.period !== period) continue;
    const state = settled(g.state, g.home && g.home.points, g.away && g.away.points);
    for (const side of [g.home, g.away]) {
      if (side && side.teamId != null) byTeam.set(side.teamId, state);
    }
  }
  return byTeam;
}

/**
 * The home page's notice about the free limits (C6), from this isolate's counts: from Protect on Worker requests a
 * warning before Cloudflare's daily limit; once another limit is reached, what is paused and until when; and for a
 * day after pages saw Cloudflare's limit page, when it happened. Null when there is nothing to say.
 */
export function siteNoticeOf(env, now = Date.now()) {
  const b = brakeNow(now);
  const usage = paceUsage();
  const outage = usage && usage.outage ? usage.outage : null;
  let notice = null;
  if (b.brake === 'limit' && b.limit && b.limit !== 'worker' && LIMIT_COPY[b.limit]) notice = { kind: 'limit', limit: b.limit, text: LIMIT_COPY[b.limit] };
  else if ((b.brake === 'protect' || b.brake === 'limit') && b.limit === 'worker') notice = { kind: 'busy', text: busyWarning(clockIsOn(env)) };
  if (!notice && !outage) return null;
  return { ...(notice || {}), ...(outage ? { outage: { ...outage, clockOn: clockIsOn(env) } } : {}) };
}

export async function dashboardPayload(env, ctx) {
  const [scoreboard, matchups, live, schedules] = await Promise.all([
    readDigest(env, 'scoreboard_digest', ctx),
    readDigest(env, 'matchup_digest', ctx),
    readDigest(env, 'live_scoring_digest', ctx),
    readDigest(env, 'bye_weeks', ctx),
  ]);
  const states = matchupStates(live, matchups && matchups.matchupPeriod);

  /* The fantasy week decides which NFL games are shown.
     ESPN advances its own NFL week a day or two after the scoring period
     rolls, so for part of every week the two disagree — and during it the
     strip was showing the games just played beside a fantasy strip already on
     the next week. The fantasy week is the one the reader is looking at, so
     the fixtures follow it. The scoreboard is preferred whenever it is
     describing that same week, because it is the fresher of the two and the
     only one with a live clock in it. */
  const fantasyWeek = matchups && matchups.matchupPeriod;
  const boardWeek = scoreboard && scoreboard.week;
  const scheduled = ((schedules && schedules.fixtures) || {})[fantasyWeek] || [];
  const boardMatchesWeek = boardWeek == null || fantasyWeek == null
    || Number(boardWeek) === Number(fantasyWeek);
  const nflGames = (boardMatchesWeek || !scheduled.length)
    ? ((scoreboard && scoreboard.games) || [])
    : scheduled;
  const nflLive = nflGames.filter((g) => g.inProgress).length;

  /* The matchup digest is built from the scoring payload and cannot know
     whether the NFL games behind a fixture have finished, so the state is
     joined on from the live digest and only falls back to the old reading
     where there is no live entry to join against. */
  const fanGames = ((matchups && matchups.games) || []).map((g) => {
    const state = states.get(g.home && g.home.teamId)
      || states.get(g.away && g.away.teamId)
      || (g.winner ? 'final' : (g.started ? 'live' : 'pre'));
    return { ...g, state };
  });
  const fanLive = fanGames.filter((g) => g.state === 'live').length;

  return {
    ok: true,
    // The site's own notices (C6): a warning before the daily Worker request limit, a limit reached that the site's
    // code runs past, and the next day's note about a cutoff pages saw. Templates; the page fills in the times.
    siteNotice: siteNoticeOf(env),
    nfl: {
      live: nflLive,
      summary: nflLive
        ? `${nflLive} live`
        : (nflGames.length ? `${nflGames.length} games` : ''),
      games: nflGames.slice(0, 16),
    },
    fantasy: {
      live: fanLive,
      identified: matchups ? Boolean(matchups.identified) : true,
      summary: fanGames.length
        ? (fanLive ? `${fanLive} live` : `Week ${matchups.matchupPeriod}`)
        : '',
      games: fanGames.slice(0, 16),
    },
    headlines: await headlines(env, ctx),
  };
}

/**
 * The slower half of the dashboard: standings, the selected team's card, its
 * injury alerts and recent league activity.
 *
 * Split from the 15-second status poll because none of it changes at that
 * cadence, and because the roster join is only needed for one team at a time.
 */
async function dashboardBoard(env, ctx, url) {
  return json(await boardPayload(env, ctx, url.searchParams.get('team')));
}

export async function boardPayload(env, ctx, teamId) {
  // Rules and team identity ride along with the board poll rather than the
  // 15-second status poll: slow-moving data on the slow-moving endpoint.
  revalidate(env, 'league_settings', ctx);
  revalidate(env, 'league_teams', ctx);

  const [standings, matchups, rosters, injuries, transactions, scoreboard, live, schedules] =
    await Promise.all([
      readDigest(env, 'standings_digest', ctx),
      readDigest(env, 'matchup_digest', ctx),
      readDigest(env, 'roster_digest', ctx),
      readDigest(env, 'injuries_digest', ctx),
      readDigest(env, 'transaction_digest', ctx),
      readDigest(env, 'scoreboard_digest', ctx),
      // Projections and win probability live here rather than in the matchup
      // digest, and the card wants them the moment the first game is under way.
      readDigest(env, 'live_scoring_digest', ctx),
      // Whole-season kickoff times. The scoreboard only knows the week ESPN
      // calls current, which lags the scoring period.
      readDigest(env, 'bye_weeks', ctx),
    ]);

  const out = {
    ok: true,
    // False while the team identity payload has not arrived. A surface that
    // renders "Team 1" looks like a league whose owners never set a name;
    // saying the data has not loaded yet is the truth.
    identified: Boolean(standings && standings.identified),
    standings: standings
      ? { started: standings.started, identified: Boolean(standings.identified),
          rows: standings.rows.slice(0, 12), places: await playoffPlaces(env, ctx) }
      : { started: false, identified: false, rows: [] },
    // Fortune Teller's simulated odds for the Sim % column, or why there are none yet.
    sim: await simOdds(env),
    transactions: (transactions && transactions.identified)
      ? ((transactions && transactions.items) || []) : [],
    myTeam: null,
    injuries: [],
  };

  if (!teamId) return out;

  const id = Number(teamId);
  const row = ((standings && standings.rows) || []).find((r) => r.teamId === id) || null;
  const roster = ((rosters && rosters.teams) || {})[id] || [];
  const starters = roster.filter((p) => p.starter);

  // The matchup this team is in this week, from whichever side it sits on.
  let matchup = null;
  for (const g of (matchups && matchups.games) || []) {
    if (g.home.teamId === id) { matchup = { me: g.home, opp: g.away, side: 'HOME', game: g }; break; }
    if (g.away.teamId === id) { matchup = { me: g.away, opp: g.home, side: 'AWAY', game: g }; break; }
  }

  // Kickoff is the earliest game any starter in the matchup is involved in —
  // both lineups, not just the reader's. The countdown answers "when does this
  // matchup start mattering", and it starts mattering when the first of the
  // thirty-six players on the two starting lineups takes the field. Measuring
  // only one side made the same fixture show two different times depending on
  // which team you had selected, which is plainly wrong for a shared event.
  const kickoffs = (scoreboard && scoreboard.kickoffs) || {};
  const seasonKickoffs = (schedules && schedules.kickoffs) || {};
  const thisWeek = matchups && matchups.matchupPeriod;
  /* The team's own schedule first, because it covers the whole season and the
     scoreboard covers only whichever week ESPN currently calls this one. The
     scoreboard is still the fallback: it is the fresher of the two once the
     two agree, and a fork with no schedule pulled yet still gets a countdown. */
  const kickoffAt = (abbrev) => {
    const forTeam = seasonKickoffs[abbrev];
    const scheduled = forTeam && thisWeek != null ? forTeam[thisWeek] : null;
    return scheduled || kickoffs[abbrev] || null;
  };
  const earliestFor = (lineup) => {
    let first = null;
    for (const p of lineup) {
      const k = kickoffAt(p.nfl);
      if (!k) continue;
      if (!first || k < first) first = k;
    }
    return first;
  };
  const rosterOf = (tid) => ((rosters && rosters.teams) || {})[tid] || [];

  const oppStarters = matchup ? rosterOf(matchup.opp.teamId).filter((p) => p.starter) : [];
  const myFirst = earliestFor(starters);
  const oppFirst = earliestFor(oppStarters);
  let earliest = myFirst;
  if (oppFirst && (!earliest || oppFirst < earliest)) earliest = oppFirst;

  // The opponent's season shape is the whole point of a matchup card. Showing
  // it for one side only left the reader to go and look the other side up.
  const oppRow = matchup
    ? ((standings && standings.rows) || []).find((r) => r.teamId === matchup.opp.teamId) || null
    : null;
  const seasonLine = (r) => (r ? {
    record: `${r.wins}-${r.losses}${r.ties ? '-' + r.ties : ''}`,
    rank: r.rank,
    pointsFor: r.pointsFor,
    owner: r.owner || '',
  } : null);

  /* The reader's side of the live digest, for projections and win probability.
   * Matched on team id rather than on position in the schedule, because the two
   * digests are built from different payloads and need not agree on order. */
  let liveMe = null;
  let liveOpp = null;
  let liveGame = null;
  for (const g of (live && live.games) || []) {
    // Same guard as above: a live entry from a period that has already rolled
    // describes a different fixture entirely.
    if (matchup && matchup.game && g.period != null
      && matchup.game.period != null && g.period !== matchup.game.period) continue;
    if (g.home && g.home.teamId === id) { liveMe = g.home; liveOpp = g.away; liveGame = g; break; }
    if (g.away && g.away.teamId === id) { liveMe = g.away; liveOpp = g.home; liveGame = g; break; }
  }

  /* Whether this matchup is under way.
   *
   * Points alone are the wrong test: a fixture whose first game kicked off ten
   * minutes ago has a real, live scoreline of nothing-nothing, and the card was
   * showing a countdown to a kickoff that had already happened. Kickoff having
   * passed is what makes a matchup live; points are what it is worth so far. */
  const kickedOff = Boolean(earliest) && Date.parse(earliest) <= Date.now();
  /* Kickoff having passed is only evidence about this week if the kickoff
     belongs to this week. At a period rollover the scoreboard still describes
     last week's fixtures, so every kickoff reads as long past and a matchup
     nobody has played showed as live, nil-nil, with a win-probability dial on
     it. A live entry for the current period is what confirms the week is
     actually under way; points on the board settle it either way. */
  const liveState = liveGame
    ? settled(liveGame.state, matchup.me.points, matchup.opp.points) : null;
  const inPlay = Boolean(matchup
    && (matchup.game.started || (liveState ? liveState !== 'pre' : kickedOff)));

  out.myTeam = {
    teamId: id,
    name: row ? row.name : (matchup ? matchup.me.name : `Team ${id}`),
    owner: row ? row.owner : '',
    logo: row ? row.logo : (matchup ? matchup.me.logo : null),
    record: row ? `${row.wins}-${row.losses}${row.ties ? '-' + row.ties : ''}` : null,
    rank: row ? row.rank : null,
    pointsFor: row ? row.pointsFor : null,
    seasonStarted: Boolean(standings && standings.started),
    starters: starters.length,
    kickoff: earliest,
    abbrev: row ? row.abbrev : (matchup ? matchup.me.abbrev : ''),
    matchup: matchup ? {
      opponent: matchup.opp.name,
      opponentAbbrev: matchup.opp.abbrev,
      opponentLogo: matchup.opp.logo,
      opponentOwner: oppRow ? oppRow.owner : '',
      opponentSeason: seasonLine(oppRow),
      mySeason: seasonLine(row),
      myPoints: matchup.me.points,
      oppPoints: matchup.opp.points,
      started: matchup.game.started,
      // Under way, as opposed to having scored: see kickedOff above.
      inPlay,
      myProjected: liveMe ? liveMe.projected : null,
      oppProjected: liveOpp ? liveOpp.projected : null,
      myWinProb: liveMe ? liveMe.winProb : null,
      winner: matchup.game.winner,
      /* Settled, which is not the same as having a winner recorded. See
         matchupStates above. */
      final: liveGame
        ? settled(liveGame.state, matchup.me.points, matchup.opp.points) === 'final'
        : Boolean(matchup.game.winner),
      period: matchup.game.period,
    } : null,
  };

  // Only injuries that affect this roster, and only recent ones.
  const cutoff = Date.now() - 14 * 86400000;
  const mine = new Map(roster.map((p) => [String(p.id), p]));
  out.injuries = (((injuries && injuries.players) || [])
    .filter((p) => p.status && p.status !== 'ACTIVE' && mine.has(String(p.id)))
    .filter((p) => {
      if (!p.date) return true;
      const t = Date.parse(p.date);
      return !Number.isFinite(t) || t >= cutoff;
    })
    .slice(0, 8))
    .map((p) => ({ ...p, slot: (mine.get(String(p.id)) || {}).slot || '' }));

  return out;
}

/**
 * Read a stored dataset, making sure it exists first.
 *
 * A complete miss blocks, because there is nothing to show otherwise; a stale
 * copy is returned immediately and refreshed behind the response. Every read
 * path goes through this. Reading R2 directly and accepting whatever is there
 * is what left a freshly deployed site with no league name and no team list:
 * nothing in the request path ever asked for those payloads, so the miss was
 * permanent rather than momentary.
 */
/**
 * The brake on a page view's refreshes (C5): at Economy a page refreshes nothing but live scoring (or a dataset
 * never stored at all, so no page shows nothing for want of one); at Protect, and once a limit is reached, nothing.
 * The backend's own work carries no brake, so it is never held here.
 */
function brakeAllowsRefresh(env, dataset, stored) {
  return refreshAllowed(env && env.BRAKE, { live: dataset.ttl === TTL.LIVE, stored });
}

async function ensureDataset(env, key, ctx) {
  const dataset = getDataset(key);
  if (!dataset) return null;
  const head = await headPart(env, key, 'main');
  if (!brakeAllowsRefresh(env, dataset, Boolean(head))) return head ? getPart(env, key, 'main') : null;
  if (!head) {
    await coordinatorRefresh(env, key, false);
  } else if (!isFresh(head.uploaded, dataset.ttl)) {
    const task = coordinatorRefresh(env, key, false);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
    else await task;
  }
  return getPart(env, key, 'main');
}

/**
 * Keep a dataset current without ever making anyone wait for it.
 *
 * League rules and team names change rarely, but they do change — a scoring
 * tweak or a renamed team should surface within hours, not on the next cold
 * deploy. Neither is time-sensitive enough to justify blocking a response, so
 * this only ever refreshes behind one, and does nothing at all on a complete
 * miss (the blocking read paths handle that case).
 */
function revalidate(env, key, ctx) {
  const dataset = getDataset(key);
  if (!dataset || !ctx || typeof ctx.waitUntil !== 'function') return;
  ctx.waitUntil((async () => {
    const head = await headPart(env, key, 'main');
    if (head && !isFresh(head.uploaded, dataset.ttl) && brakeAllowsRefresh(env, dataset, true)) {
      await coordinatorRefresh(env, key, false);
    }
  })());
}

/** Fetch a derived digest, refreshing behind the response when it is stale. */
async function readDigest(env, key, ctx) {
  const obj = await ensureDataset(env, key, ctx);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

const NEWS_LABELS = {
  Story: 'Story', Media: 'Video', HeadlineNews: 'News',
  Preview: 'Preview', Recap: 'Recap', Analysis: 'Analysis',
};

// Headlines change slowly and are shared by every viewer, so one isolate-level
// cache spares the parse on every poll.
let newsCache = null, newsAt = 0;

async function headlines(env, ctx) {
  if (newsCache && Date.now() - newsAt < 120000) return newsCache;
  try {
    const obj = await ensureDataset(env, 'nfl_news', ctx);
    if (!obj) return [];
    const doc = await obj.json();
    newsCache = (doc.articles || []).slice(0, 5).map((a) => ({
      headline: a.headline || '',
      link: (a.links && a.links.web && a.links.web.href) || null,
      source: NEWS_LABELS[a.type] || 'ESPN',
    })).filter((h) => h.headline);
    newsAt = Date.now();
    return newsCache;
  } catch {
    return [];
  }
}

/**
 * Fetch a remote team logo server-side and hand it back same-origin.
 *
 * Only reachable with a League Password session, so this is not an open proxy.
 * Responses are edge-cached for a day because a team logo effectively never
 * changes, which keeps this to roughly one upstream fetch per logo per edge.
 */
async function serveImage(request, url, ctx) {
  const encoded = url.searchParams.get('u');
  if (!encoded) return placeholderImage();

  let target;
  try {
    target = b64urlDecode(encoded);
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:') return placeholderImage();
  } catch {
    return placeholderImage();
  }

  const cache = edgeCache();
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = cache ? await cache.match(cacheKey) : null;
  if (cache) countOp(hit ? 'cacheHit' : 'cacheMiss');
  if (hit) return hit;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(target, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return placeholderImage();

    const body = await res.arrayBuffer();
    if (body.byteLength > 3 * 1024 * 1024) return placeholderImage();

    const out = new Response(body, {
      headers: {
        'content-type': type,
        'cache-control': 'public, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
    if (cache && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch {
    return placeholderImage();
  }
}

/**
 * Serve a fantasy team's logo from the Worker's own store.
 *
 * Custom uploads live behind ESPN's session, so a browser cannot fetch them at
 * all; the bytes are copied into R2 on a schedule and served from here.
 *
 * Caching is keyed on the `v` fingerprint the digest embeds. When it matches
 * what is stored, the response is immutable — a logo under a given version can
 * never change, so there is nothing to revalidate. When it does not, the stored
 * bytes are still served, but briefly and without touching the edge cache: that
 * gap means a digest refreshed just ahead of the logo pass, and pinning the
 * previous image against the new version for a year would turn a few seconds of
 * skew into a permanent wrong answer.
 */
/**
 * The edge cache, when there is one.
 *
 * `caches.default` exists on Workers but not in the local harness, and a cache
 * is an optimisation rather than a dependency: if it is missing, the response
 * must still be correct. Reaching for it unguarded turned every image route
 * into a 500 the moment it ran anywhere but Cloudflare.
 */
function edgeCache() {
  try {
    return (typeof caches !== 'undefined' && caches.default) || null;
  } catch {
    return null;
  }
}

async function serveTeamLogo(env, request, url, ctx, rawId) {
  const teamId = decodeURIComponent(rawId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(teamId)) return placeholderImage();

  const wanted = url.searchParams.get('v');
  const cache = edgeCache();
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = cache ? await cache.match(cacheKey) : null;
  if (cache) countOp(hit ? 'cacheHit' : 'cacheMiss');
  if (hit) return hit;

  let obj = null;
  try {
    obj = await env.DATA.get(logoObjectKey(teamId));
  } catch {
    obj = null;
  }
  if (!obj) return placeholderImage();

  const meta = obj.customMetadata || {};
  const type = meta.contentType
    || (obj.httpMetadata && obj.httpMetadata.contentType)
    || 'image/png';
  const matched = Boolean(wanted && meta.version && wanted === meta.version);

  const body = await obj.arrayBuffer();
  const out = new Response(body, {
    headers: {
      'content-type': type,
      'cache-control': matched
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=60',
      'x-content-type-options': 'nosniff',
      ...(meta.version ? { etag: `"${meta.version}"` } : {}),
    },
  });
  if (matched && cache && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
  }
  return out;
}

/** A drawn stand-in, so a team that cannot supply a logo still reads as a team. */
function placeholderImage() {
  // A placeholder is cached only briefly. It means "no bytes stored yet", which
  // the next logo pass is expected to fix, and a long cache would outlive the
  // fix and make an empty store look like a broken one.
  return new Response(LOGO_FALLBACK_SVG, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
}

// ---------------------------------------------------------------- lookups

let leagueNameCache = null, leagueNameAt = 0;
let teamsCache = null, teamsAt = 0;

/**
 * `ensure` is opt-in because this is also rendered on the signed-out login
 * page, and an unauthenticated visitor must not be able to make the site call
 * ESPN. Authenticated callers pass it; the login and wizard pages do not.
 */
async function leagueName(env, { ensure = false, ctx = null } = {}) {
  if (leagueNameCache && Date.now() - leagueNameAt < 300000) return leagueNameCache;
  try {
    const obj = ensure
      ? await ensureDataset(env, 'league_settings', ctx)
      : await getPart(env, 'league_settings', 'main');
    if (obj) {
      const doc = await obj.json();
      const name = doc && doc.settings && doc.settings.name;
      if (name) { leagueNameCache = String(name); leagueNameAt = Date.now(); return leagueNameCache; }
    }
  } catch { /* neutral default below */ }
  return null;
}

/** Team list for the site-wide selector, from the small mTeam payload. */
async function getTeams(env, ctx) {
  if (teamsCache && Date.now() - teamsAt < 300000) return teamsCache;
  try {
    const obj = await ensureDataset(env, 'league_teams', ctx);
    if (!obj) return [];
    const doc = await obj.json();
    const members = {};
    for (const m of doc.members || []) members[m.id] = m;
    const teams = (doc.teams || []).map((t) => {
      const owner = members[(t.owners || [])[0]];
      const ownerName = owner
        ? (`${owner.firstName || ''} ${owner.lastName || ''}`.trim() || owner.displayName || 'Unknown owner')
        : 'Unknown owner';
      return { id: t.id, name: t.name || `Team ${t.id}`, owner: ownerName, logo: teamLogoUrl(t.id, t.logo) };
    });
    teams.sort((a, b) => a.owner.localeCompare(b.owner));
    teamsCache = teams; teamsAt = Date.now();
    return teams;
  } catch {
    return [];
  }
}
