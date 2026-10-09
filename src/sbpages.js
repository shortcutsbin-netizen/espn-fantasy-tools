/**
 * Site Backend: the page tabs. Every tab has the same five standard panels
 * (settings, datasets read, routes called, access, log) after the panels that
 * are about that page alone.
 */

import { DATASETS, FREE_AGENT_DEPTH, getDataset } from './datasets.js';
import { TOOLS, visibilityOf } from './tools.js';
import { TRADE_ROWS, TRADE_GROUPS } from './traderows.js';
import { RELEASE_NOTE_ITEMS } from './release.js';
import { simOdds } from './fortuneteller.js';
import { FT_ACTIVE_KEY, FT_DEFAULTS } from './ftdo.js';
import { feasibility } from './ftbuild.js';
import { DERIVATIONS } from './derive.js';
import { ENGINE_VERSION, SCORE_DIFF_SD, TIE_CHANCE, leagueState } from './ftleague.js';
import { MIN_GAP_MS, BYTE_BUDGET, MAX_EVENTS, MIN_DELTA } from './scoretimeline.js';
import { setupCodeRequired, setupCodeGeneratedAt } from './setup.js';
import { sessionHoursOf, sessionWords } from './auth.js';
import * as TA from '../app/trade-analyzer/constants.js';
import { compactExport, COMPACT_FREE_AGENT_DEPTH } from '../app/llm-export/compact.js';
import { rosterShape } from '../app/draft-helper/rosterShape.js';
import { draftPlan } from '../app/draft-helper/draftPlan.js';
import { SHARE_PARAMS } from './readers.js';
import { normaliseSiteApi } from './apikey.js';
import { SITE_API_PANELS } from './sbapi.js';
import {
  C, B, worst, hourOf, utcMidnight, median, ttlText, upstream, countEvents, eventsSince, groupEvents, latestEvents, sumReq,
  pageVisibility, visibilityLabel,
} from './sbcore.js';
import { feedRows, ftSev, gameWindow, agoText, fmtB, fmtPaths, fmtHours, aboutHours, seedingText, timelineWeeks, usage } from './sbover.js';

const P = (id, title, def) => ({ id, title, ...def });
const DAY = 86400000;
/** A trade's status in the words the home page's league activity uses (a proposal pulled by its proposer is withdrawn). */
export const TRADE_STATUS = { completed: 'Completed', on_the_table: 'On the table', pending_approval: 'Pending approval', rejected: 'Rejected', cancelled: 'Withdrawn', expired: 'Expired' };
/** The span a "still signed in" count looks back over: the sign-in length, held to the seven days the log keeps. */
const sessionSpan = async (src) => {
  const h = sessionHoursOf(await src.cfg()); const cap = 7 * 24;
  const hours = h === 'infinite' || h > cap ? cap : h;
  return { ms: hours * 3600000, words: sessionWords(hours) };
};
const day0Of = (src) => Number(src.params.day0) || utcMidnight(src.now);

// ---------------------------------------------------------------- the standard five

function routeStats(rows, method, path) {
  const want = `${method === 'GET' ? 'GET' : method} ${path}`;
  const r = sumReq(rows, (k) => k === want);
  return r;
}

function openTabs(rows, path, every) {
  if (!every) return null;
  const cur = rows[rows.length - 1];
  const now = Date.now();
  let polls = 0;
  for (const { d } of rows.slice(-2)) {
    const mins = (d.poll || {})[path] || {};
    for (const [m, n] of Object.entries(mins)) if (Number(m) >= now - 5 * 60000 - 60000 && Number(m) < Math.floor(now / 60000) * 60000) polls += n;
  }
  void cur;
  return Math.round(polls / (5 * (60 / every)));
}

function standard(page, ownSettings) {
  const up = upstream(page.datasets);
  return [
    P(`x-settings-${page.key}`, 'Settings', {
      sub: 'What an administrator controls here, and what members chose',
      sum: async (src, ctx) => {
        const v = pageVisibility(ctx.cfg, page);
        const extra = { 'fortune-teller': ctx.cfg.fortuneTeller && ctx.cfg.fortuneTeller.enabled ? 'switched on' : 'switched off', signin: `sessions last ${sessionWords(sessionHoursOf(ctx.cfg))}`,
          'trade-analyzer': `${TRADE_ROWS.filter((r) => ctx.cfg.tradeWeights && ctx.cfg.tradeWeights[r.id] != null && ctx.cfg.tradeWeights[r.id] !== r.w).length} weighting rows moved` }[page.key];
        return [null, extra ? `${v}; ${extra}` : v];
      },
      body: async (src, ctx) => {
        const items = [];
        if (page.tool) {
          const t = TOOLS.find((x) => x.key === page.tool);
          const v = visibilityOf(ctx.cfg, page.tool);
          items.push(['Visibility', C.pill(v === 'visible' ? 'ok' : v === 'admin' ? 'warn' : 'idle', visibilityLabel(v), `default ${visibilityLabel(t.defaultVisibility)}`)]);
          const st = (ctx.cfg.stamps || {}).toolVisibility || {};
          if (st[page.tool]) items.push(['Visibility changed', C.time(st[page.tool])]);
        }
        const own = ownSettings ? await ownSettings(src, ctx) : [];
        const seen = await memberSettings(src, page.key);
        return [B.kv(items.concat(own)), ...seen];
      },
    }),
    P(`x-ds-${page.key}`, 'Datasets read', {
      sub: 'Direct reads first, then everything they are built from', asof: 'ages update every second',
      sum: async (src, ctx) => {
        if (!up.size) return [null, 'reads no datasets'];
        const rows = [...up.keys()].map((k) => ctx.rowByKey[k]).filter(Boolean);
        const fresh = rows.filter((r) => r.sev === 'ok').length, bad = rows.filter((r) => r.sev === 'warn' || r.sev === 'bad').length;
        return [rows.some((r) => r.sev !== 'idle') ? worst(rows.map((r) => r.sev)) : null, `${up.size}: ${fresh} fresh, ${up.size - fresh - bad} resting or manual${bad ? `, ${bad} in trouble` : ''}`];
      },
      body: async (src, ctx) => (up.size
        ? [{ t: 'datasets', rows: [...up.keys()].map((k) => ({ ...ctx.rowByKey[k], via: up.get(k) })).filter((r) => r.key), keepOrder: true, via: true }]
        : [B.empty('This page reads no datasets: everything it shows is read as stored, without starting a refresh.')]),
    }),
    P(`x-routes-${page.key}`, 'Routes called', {
      sub: 'Requests today, counted by the site', live: true,
      sum: async (src) => {
        const rows = (await src.hours(48)).filter((r) => r.hour >= hourOf(day0Of(src)));
        let n = 0, e = 0;
        for (const [m, path] of page.routes) { const s = routeStats(rows, m, path); n += s.n; e += s.e; }
        return [e ? 'warn' : null, `${page.routes.length} routes, ${n.toLocaleString('en-US')} requests today${e ? `, ${e} errors` : ''}`];
      },
      body: async (src) => {
        const all = await src.hours(48);
        const rows = all.filter((r) => r.hour >= hourOf(day0Of(src)));
        return [B.table([['Method'], ['Route'], ['When'], ['Today', 'n'], ['Errors', 'n'], ['Median', 'n'], ['Slowest', 'n']],
          page.routes.map(([m, path, when]) => {
            const s = routeStats(rows, m, path);
            return B.row([C.code(m), C.code(path), C.txt(when), C.n(s.n), C.n(s.e), s.med != null ? C.dur(s.med) : '—', s.n ? C.dur(s.mx) : '—'], s.e ? 'warn' : null);
          })), ...(page.key === 'wizard' ? [B.note('Setup routes answer only until setup finishes, so on a site that is set up every count here stays at zero.')] : [])];
      },
    }),
    P(`x-access-${page.key}`, 'Access', {
      sub: 'Visits by the team chosen on each browser', live: true,
      sum: async (src) => {
        if (page.key === 'wizard') return [null, 'no visits once setup has finished'];
        if (page.key === 'signin') return [null, `${countEvents(src, day0Of(src), "AND text = 'Signed in'").n} sign-ins today`];
        const t = countEvents(src, day0Of(src), "AND kind = 'visit' AND page = ?", page.key);
        return [null, `${t.n} visit${t.n === 1 ? '' : 's'} today by ${t.teams} team${t.teams === 1 ? '' : 's'}`];
      },
      body: async (src) => {
        if (page.key === 'wizard') return [B.empty('The setup pages answer only before setup finishes, and recording starts when it does, so there are no visits to show.')];
        const kindWhere = page.key === 'signin' ? "AND text = 'Signed in'" : "AND kind = 'visit' AND page = ?";
        const binds = page.key === 'signin' ? [] : [page.key];
        const today = countEvents(src, day0Of(src), kindWhere, ...binds);
        const week = countEvents(src, src.now - 7 * DAY, kindWhere, ...binds);
        const last = latestEvents(src, kindWhere, 1, ...binds)[0];
        const per = [...groupEvents(src, src.now - 7 * DAY, kindWhere, 'team', ...binds)].map(([team, g]) => ({ team, n: g.n })).sort((a, b) => b.n - a.n);
        const max = Math.max(1, ...per.map((r) => r.n));
        return [B.kv([[page.key === 'signin' ? 'Sign-ins today' : 'Visits today', C.n(today.n)], ['Teams today', C.n(today.teams)],
          [page.key === 'signin' ? 'Sign-ins, 7 days' : 'Visits, 7 days', C.n(week.n)], ['Last', last ? C.mix(C.time(last.at), C.team(last.team)) : '—']]),
          ...(per.length ? [B.sub('By chosen team, last 7 days'), B.bars(per.map((r) => ({ l: C.team(r.team), v: r.n, max, r: C.n(r.n) })))]
            : [B.empty('No visits recorded yet.')])];
      },
    }),
    P(`x-log-${page.key}`, 'Log', {
      sub: 'This page\'s part of the site log', live: true,
      sum: async (src) => {
        const e = latestEvents(src, 'AND page = ?', 1, page.key)[0];
        return [null, e ? `latest ${agoText(src.now - e.at)}: ${e.text}` : 'nothing logged yet'];
      },
      body: async (src) => {
        const rows = latestEvents(src, 'AND page = ?', 15, page.key);
        return rows.length ? [{ t: 'feed', items: feedRows(rows, []) }, B.btn('Open in Activity', 'activity', page.key)] : [B.empty('Nothing logged for this page yet.')];
      },
    }),
  ];
}

/** Member settings seen on this page's visits today: counts only. */
async function memberSettings(src, pageKey) {
  if (!['home', 'draft-helper', 'live-matchups', 'hall-of-fame', 'trade-analyzer', 'fortune-teller', 'llm-export', 'config', 'site-backend'].includes(pageKey)) return [];
  const rows = (await src.hours(48)).filter((r) => r.hour >= hourOf(day0Of(src)));
  const tot = { theme: {}, motion: {}, tz: {} };
  for (const { d } of rows) for (const g of ['theme', 'motion', 'tz']) for (const [k, n] of Object.entries((d.settings || {})[g] || {})) tot[g][k] = (tot[g][k] || 0) + n;
  if (!Object.keys(tot.theme).length) return [];
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ');
  return [B.sub('Member settings seen today, across every page'), B.kv([['Theme', C.txt(fmt(tot.theme))], ['Motion', C.txt(fmt(tot.motion))], ['Time zone', C.txt(fmt(tot.tz))]])];
}

// ---------------------------------------------------------------- shared own panels

async function matchupRows(src, withProj) {
  const lsd = await src.digest('live_scoring_digest');
  if (!lsd || !(lsd.games || []).length) return [B.empty('This week\'s matchups have not been stored yet.')];
  const cols = [['Away'], ['Score', 'n'], ['Home'], ['Score', 'n'], ['Win chance', 'n']].concat(withProj ? [['Projected', 'n']] : []).concat([['State']]);
  return [B.table(cols, lsd.games.map((g) => {
    const st = g.state === 'live' ? C.pill('run', 'live') : g.state === 'final' ? C.pill('idle', 'final') : C.pill('ok', 'not started');
    const cells = [C.team(g.away.teamId), C.txt((g.away.points || 0).toFixed(1)), C.team(g.home.teamId), C.txt((g.home.points || 0).toFixed(1)),
      C.txt(`${g.away.winProb ?? '?'}% / ${g.home.winProb ?? '?'}%`)];
    if (withProj) cells.push(C.txt(`${(g.away.projected || 0).toFixed(1)} / ${(g.home.projected || 0).toFixed(1)}`));
    cells.push(st);
    return B.row(cells, g.state === 'live' ? 'run' : null);
  })), B.kv([['Week', C.n(lsd.matchupPeriod)], ['Read', C.time(lsd.generatedAt)]])];
}

async function logoPanelBody(src, ctx) {
  const { OVERVIEW } = await import('./sbover.js');
  const p = OVERVIEW.find((x) => x.id === 'p-logos');
  return p.body(src, ctx);
}

function polling(routes) {
  return async (src) => {
    const all = await src.hours(48);
    const rows = all.filter((r) => r.hour >= hourOf(day0Of(src)));
    return [B.table([['Route'], ['Every', 'n'], ['Today', 'n'], ['Open tabs now', 'n']], routes.map(([path, every]) => {
      const s = routeStats(rows, 'GET', path);
      const open = openTabs(all, path, every);
      return B.row([C.code(path), C.txt(every ? `${every} s` : 'once'), C.n(s.n), open == null ? '—' : C.n(open)]);
    })), B.note('Open tabs are estimated from polls in the last five minutes. A tab stops polling while hidden, and after four hours without a tap.')];
  };
}

// ---------------------------------------------------------------- per page

const OWN = {
  home: {
    settings: async (src, ctx) => {
      const s = await src.settings();
      const sim = await simOdds(src.env).catch(() => null);
      return [['Tools on the home page', C.txt(`${TOOLS.filter((t) => visibilityOf(ctx.cfg, t.key) === 'visible').length} open, ${TOOLS.filter((t) => visibilityOf(ctx.cfg, t.key) === 'admin').length} locked`)],
        ['Update notice', C.txt(`version ${src.facts.version}`, `${(src.facts.releaseItems || RELEASE_NOTE_ITEMS).length} items`)],
        ['Playoff places', C.n(s && s.s.scheduleSettings ? s.s.scheduleSettings.playoffTeamCount : 0, 'for the Playoffs line')],
        ['Sim % column', C.txt(sim && sim.byTeam ? 'showing' : 'hidden until a simulation has run')]];
    },
    panels: [
      P('h-board', 'This week\'s matchups', { live: true, sum: async (src) => { const l = await src.digest('live_scoring_digest'); if (!l) return [null, 'not stored yet']; const g = l.games || []; const live = g.filter((x) => x.state === 'live').length; return [live ? 'run' : null, `${g.filter((x) => x.state !== 'pre').length} of ${g.length} under way`]; }, body: (src) => matchupRows(src, false) }),
      P('h-standings', 'Standings as members see them', {
        sum: async (src) => { const s = await src.settings(); return [null, `Playoffs line under place ${s && s.s.scheduleSettings ? s.s.scheduleSettings.playoffTeamCount : '?'}`]; },
        body: async (src) => {
          const st = await src.digest('standings_digest');
          const s = await src.settings();
          const sim = await simOdds(src.env).catch(() => null);
          if (!st || !(st.rows || []).length) return [B.empty('Standings have not been stored yet.')];
          const places = s && s.s.scheduleSettings ? s.s.scheduleSettings.playoffTeamCount : 0;
          const rows = st.rows.slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
          const out = [];
          rows.forEach((r, i) => {
            const cells = [C.n(r.rank || i + 1), C.team(r.teamId), C.txt(`${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`), C.txt((r.pointsFor || 0).toFixed(1)),
              typeof r.playoffPct === 'number' ? C.pct(r.playoffPct) : '—'];
            if (sim && sim.byTeam) cells.push(sim.byTeam[r.teamId] != null ? C.pct(sim.byTeam[r.teamId]) : '—');
            out.push(B.row(cells));
            if (places && i === places - 1 && i < rows.length - 1) out.push({ line: 'Playoffs' });
          });
          const cols = [['Seed', 'n'], ['Team'], ['Record', 'n'], ['Points', 'n'], ['Playoff %', 'n']].concat(sim && sim.byTeam ? [['Sim %', 'n']] : []);
          return [B.table(cols, out), B.note(sim && sim.byTeam ? 'Sim % is Fortune Teller\'s exact figure; Playoff % is ESPN\'s.' : 'The Sim % column appears once Fortune Teller has run a real simulation.')];
        },
      }),
      P('h-banners', 'Banners and tickers now', {
        live: true,
        sum: async (src, ctx) => { const miss = ctx.rows.filter((r) => r.state === 'missing' && r.tier !== 'probe').length; const on = [ctx.espn.failing && 'ESPN alert', miss && 're-pull banner'].filter(Boolean); return [on.length ? 'warn' : null, on.length ? `${on.join(' and ')} showing` : 'no banners showing']; },
        body: async (src, ctx) => {
          const lsd = await src.digest('live_scoring_digest');
          const miss = ctx.rows.filter((r) => r.state === 'missing' && r.tier !== 'probe').length;
          const sim = await simOdds(src.env).catch(() => null);
          return [B.kv([['ESPN alert', ctx.espn.failing ? C.pill('warn', 'showing') : C.txt('not showing')], ['Re-pull banner', miss ? C.pill('warn', 'showing') : C.txt('not showing')],
            ['Update notice', C.txt(`version ${src.facts.version}`, 'shown once per browser')], ['NFL ticker', C.txt(`${ctx.window.live} live`, `${ctx.window.final} final, ${ctx.window.upcoming} upcoming`)],
            ['Fantasy ticker', C.txt(`${lsd ? (lsd.games || []).filter((g) => g.state === 'live').length : 0} matchups in play`)], ['Sim % column', C.txt(sim && sim.byTeam ? 'showing' : 'hidden')]])];
        },
      }),
      P('h-activity', 'League activity', {
        sum: async (src) => { const t = await src.digest('transaction_digest'); return [null, t ? `${(t.items || []).length} transactions listed` : 'not stored yet']; },
        body: async (src) => {
          const t = await src.digest('transaction_digest');
          if (!t) return [B.empty('League activity has not been stored yet.')];
          const by = {};
          const kinds = new Set();
          for (const it of t.items || []) { const w = it.scoringPeriod || 0; const k = it.kind || 'other'; kinds.add(k); (by[w] = by[w] || {})[k] = ((by[w] || {})[k] || 0) + 1; }
          const ks = [...kinds].sort();
          const weeks = Object.keys(by).map(Number).sort((a, b) => b - a);
          return [B.table([['Week', 'n']].concat(ks.map((k) => [k, 'n'])), weeks.map((w) => B.row([C.n(w)].concat(ks.map((k) => C.n(by[w][k] || 0)))))),
            B.kv([['Default range', C.txt('7 days')], ['Built', C.time(t.generatedAt)]]),
            B.note('Lineup changes and draft picks are never listed, and a waiver claim appears only once it has resolved.')];
        },
      }),
      P('h-news', 'News and injuries', {
        live: true,
        sum: async (src, ctx) => { const r = ctx.rowByKey.nfl_news; return [null, r && r.newest ? `news updated ${agoText(src.now - Date.parse(r.newest))}` : 'not stored yet']; },
        body: async (src, ctx) => {
          const n = ctx.rowByKey.nfl_news, i = ctx.rowByKey.injuries_digest;
          const news = await src.digest('nfl_news');
          return [B.kv([['Around the league', n && n.newest ? C.time(n.newest, `${(news && news.articles ? news.articles.length : 0)} articles`) : C.txt('not stored')],
            ['Injury watch', i && i.newest ? C.time(i.newest, fmtB(i.bytes)) : C.txt('not stored')], ['Images', C.txt('through /api/img, cached at the edge for a day')]])];
        },
      }),
      P('h-poll', 'Polling', { live: true, sum: async (src) => { const o = openTabs(await src.hours(48), '/api/dashboard/status', 15); return [null, `${o || 0} home tab${o === 1 ? '' : 's'} open now`]; }, body: polling([['/api/dashboard/status', 15], ['/api/dashboard/board', 90]]) }),
      P('h-logos', 'Logos', { live: true, sum: async (src, ctx) => { const t = Object.keys(ctx.logoState).length; return [ctx.logosFailing.length ? 'warn' : 'ok', t ? `${t - ctx.logosFailing.length} of ${t} current` : 'no logo pass yet']; }, body: logoPanelBody }),
    ],
  },

  signin: {
    settings: async (src) => [['Session length', C.txt(sessionWords(sessionHoursOf(await src.cfg())))], ['Throttle', C.txt('10 failures in 10 minutes per IP address')],
      ['Password hashing', C.txt('PBKDF2, 100,000 iterations')], ['Shortest password', C.txt('8 characters')], ['Tool unlock', C.txt('30 minutes, for that tool only')]],
    panels: [
      P('s-hours', 'Sign-ins by hour', {
        sum: async (src) => [null, `${countEvents(src, src.now - 3 * DAY, "AND text = 'Signed in'").n} in the last 3 days`],
        body: async (src) => [{ t: 'heat', days: 3, times: eventsSince(src, src.now - 3 * DAY, "AND text = 'Signed in'").map((r) => r.at).sort((a, b) => a - b) },
          B.note('Hours in your time zone. Darker means more sign-ins.')],
      }),
      P('s-sessions', 'Sessions', {
        live: true,
        sum: async (src) => { const w = await sessionSpan(src); return [null, `${countEvents(src, src.now - w.ms, "AND text = 'Signed in'").n} signed in within ${w.words}`]; },
        body: async (src) => {
          const d0 = day0Of(src); const w = await sessionSpan(src);
          return [B.kv([['Possibly still signed in', C.n(countEvents(src, src.now - w.ms, "AND text = 'Signed in'").n, `signed in within the last ${w.words}`)],
            ['Lapsed today', C.n(countEvents(src, d0, "AND text = 'Session lapsed'").n)], ['Signed out today', C.n(countEvents(src, d0, "AND text = 'Signed out'").n)],
            ['Tool unlocks today', C.n(countEvents(src, d0, "AND kind = 'admin' AND text LIKE 'Unlocked %'").n, '30 minutes each')]])];
        },
      }),
      P('s-fail', 'Failed sign-ins', {
        live: true,
        sum: async (src) => { const n = countEvents(src, day0Of(src), "AND text = 'Sign-in failed'").n; const b = countEvents(src, day0Of(src), "AND text = 'Sign-in blocked by the throttle'").n; return [b ? 'warn' : null, `${n} today, ${b} blocked`]; },
        body: async (src) => {
          const f = eventsSince(src, src.now - 3 * DAY, "AND text = 'Sign-in failed'").slice().sort((a, b) => a.at - b.at);
          const perHour = {}; for (const r of f) { const h = hourOf(r.at); perHour[h] = (perHour[h] || 0) + 1; }
          const last = f[f.length - 1];
          return [B.kv([['Failed, 3 days', C.n(f.length)], ['Most in one hour', C.n(Math.max(0, ...Object.values(perHour)))],
            ['Blocked by the throttle, 3 days', C.n(countEvents(src, src.now - 3 * DAY, "AND text = 'Sign-in blocked by the throttle'").n)],
            ['Last failure', last ? C.mix(C.time(last.at), C.team(last.team)) : '—']]),
            B.note('A failure names the team chosen on that browser, which may simply be whoever used it last.')];
        },
      }),
      P('s-admin', 'Admin Password', {
        sum: async (src) => { const r = countEvents(src, src.now - 3 * DAY, "AND kind = 'admin' AND text LIKE 'Admin Password refused%'").n; return [r ? 'warn' : null, `${r} refused in 3 days`]; },
        body: async (src) => {
          const acc = countEvents(src, src.now - 3 * DAY, "AND kind = 'admin' AND (text LIKE 'Admin Password accepted%' OR text LIKE 'Unlocked %')");
          const ref = countEvents(src, src.now - 3 * DAY, "AND kind = 'admin' AND text LIKE 'Admin Password refused%'");
          const last = latestEvents(src, "AND kind = 'admin' AND (text LIKE 'Admin Password accepted%' OR text LIKE 'Unlocked %')", 1)[0];
          return [B.kv([['Accepted, 3 days', C.n(acc.n)], ['Refused, 3 days', C.n(ref.n)], ['Last accepted', last ? C.time(last.at) : '—'],
            ['Used for', C.txt('Site Configuration, and unlocking admin-only tools')]])];
        },
      }),
      P('s-throttle', 'Throttle', {
        sum: async (src) => { const b = countEvents(src, src.now - DAY, "AND text = 'Sign-in blocked by the throttle'").n; return [b ? 'warn' : 'ok', b ? `${b} blocked in 24 hours` : 'nobody blocked in 24 hours']; },
        body: async () => [B.kv([['Blocks after', C.txt('10 failures in 10 minutes')], ['Counted per', C.txt('IP address, inside its own object')], ['Tells the log', C.txt('nothing about the IP address')]]),
          B.note('A blocked attempt is logged as "Sign-in blocked by the throttle", with the team chosen on that browser.')],
      }),
    ],
  },

  wizard: {
    settings: async (src, ctx) => [['Setup code', C.txt(setupCodeRequired() ? 'Plan A: baked in at build' : 'Plan B: none baked in')],
      ['Setup finished', C.at(ctx.cfg.setupCompletedAt)], ['History seasons', C.txt((ctx.cfg.historySeasons || []).join(', ') || 'none', 'discovered at setup')]],
    panels: [
      P('w-steps', 'Steps', {
        sum: async (src, ctx) => [ctx.finished ? 'ok' : 'bad', ctx.finished ? `finished ${new Date(ctx.cfg.setupCompletedAt).toISOString().slice(0, 10)}` : 'not finished'],
        body: async (src, ctx) => {
          const j = await src.jobs();
          const c = ctx.cfg;
          const done = (ok) => (ok ? C.pill('ok', 'done') : C.pill('idle', 'not done'));
          return [B.table([['Step'], ['Name'], ['Result'], ['State']], [
            B.row([C.txt('01'), C.txt('Access'), C.txt(setupCodeRequired() ? 'setup code accepted' : 'no setup code baked in'), done(Boolean(c.leaguePasswordHash))]),
            B.row([C.txt('02'), C.txt('Passwords'), C.txt('League and Admin Passwords set'), done(Boolean(c.leaguePasswordHash && c.adminPasswordHash))]),
            B.row([C.txt('03'), C.txt('League'), C.txt(c.leagueId ? `league ${c.leagueId}, ${c.leaguePrivate ? 'private' : 'public'}; ${(c.historySeasons || []).length} past seasons found` : 'not connected'), done(Boolean(c.leagueId))]),
            B.row([C.txt('04'), C.txt('Tools'), C.txt(`${TOOLS.filter((t) => visibilityOf(c, t.key) !== 'hidden').length} of ${TOOLS.length} included`), done(Object.keys(c.toolVisibility || {}).length > 0)]),
            B.row([C.txt('—'), C.txt('League data'), C.txt(j.prime ? `${j.prime.done || 0} of ${j.prime.total || 0} datasets` : 'no record'), done(Boolean(j.prime && j.prime.complete))]),
            B.row([C.txt('05'), C.txt('History'), C.txt(j.history ? `${j.history.eventsDone || 0} of ${j.history.eventsTotal || 0} box scores` : 'skipped or not run'), j.history && j.history.complete ? C.pill('ok', 'done') : C.pill('idle', j.history ? 'in progress' : 'skipped')]),
          ]), B.kv([['Setup finished', C.at(c.setupCompletedAt)]])];
        },
      }),
      P('w-prime', 'League data pass', {
        sum: async (src) => { const j = (await src.jobs()).prime; return [j ? (j.failures && j.failures.length ? 'warn' : 'ok') : null, j ? `${j.done || 0} of ${j.total || 0} datasets${j.failures && j.failures.length ? `, ${j.failures.length} failed` : ''}` : 'no record']; },
        body: async (src) => {
          const j = (await src.jobs()).prime;
          if (!j) return [B.empty('No record of the league data pass on this deployment.')];
          return [B.kv([['Datasets', C.txt(`${j.done || 0} of ${j.total || 0}`, 'raw first, then digests')], ['Per call', C.txt('6 datasets')], ['Tries each', C.txt('3')],
            ['Failed', C.n((j.failures || []).length)], ['Started', C.time(j.startedAt)], ['Finished', C.time(j.finishedAt)], ['Run again from', C.txt('Site Configuration')]]),
            ...((j.failures || []).length ? [B.list(j.failures.slice(0, 12).map((f) => (typeof f === 'string' ? f : `${f.key || f.dataset || ''}: ${f.error || ''}`)))] : [])];
        },
      }),
      P('w-history', 'Box-score history', { sum: historySum, body: historyBody }),
      P('w-code', 'Setup code', {
        sum: async () => [null, setupCodeRequired() ? 'baked in at build' : 'none baked in'],
        body: async () => [B.kv([['Setup code', C.txt(setupCodeRequired() ? 'Plan A' : 'Plan B', setupCodeRequired() ? 'printed in the build log, hashed into the Worker' : 'setup was open until the first password was set')],
          ['Generated', C.at(setupCodeGeneratedAt())], ['Stored as', C.txt('a hash in the build, never the code')], ['Used', C.txt('once, at step 01')]])],
      }),
    ],
  },

  config: {
    settings: async (src, ctx) => [['Admin Password', C.txt(ctx.cfg.adminPasswordHash ? 'set' : 'not set', 'checked on every admin call')],
      ['Fortune Teller', C.txt(ctx.cfg.fortuneTeller && ctx.cfg.fortuneTeller.enabled ? 'on' : 'off')],
      ['Trade rows moved', C.txt(`${TRADE_ROWS.filter((r) => ctx.cfg.tradeWeights && ctx.cfg.tradeWeights[r.id] != null && ctx.cfg.tradeWeights[r.id] !== r.w).length} of ${TRADE_ROWS.length}`)]],
    panels: [
      P('c-panels', 'What the page controls', {
        sum: async () => [null, '8 panels'],
        body: async () => [B.table([['Panel'], ['Changes'], ['Route']], [
          ['League', 'league ID and history seasons', '/api/admin/config'], ['ESPN cookies', 'espn_s2 and SWID', '/api/admin/cookies'],
          ['Passwords', 'League and Admin Passwords', '/api/admin/passwords'], ['Tools', 'visible, admin-only or hidden', '/api/admin/tool-visibility'], ['Home page order', 'the order of the home page\'s tiles', '/api/admin/tool-order'],
          ['Fortune Teller', 'on or off, check now, rebuild', '/api/admin/fortune-teller'], ['Trade weighting', 'the league\'s own row weights', '/api/admin/trade-weights'],
          ['Re-pull', 'league data and box-score history', '/api/admin/prime-batch, /api/admin/history-batch'],
        ].map((r) => B.row([C.txt(r[0]), C.txt(r[1]), C.code(r[2])])))],
      }),
      P('c-changes', 'When each setting last changed', {
        sum: async (src, ctx) => { const st = ctx.cfg.stamps || {}; const all = [st.espnCookies, st.leaguePassword, st.adminPassword, st.tradeWeights, st.toolOrder, ...Object.values(st.toolVisibility || {}), ctx.cfg.fortuneTeller && ctx.cfg.fortuneTeller.changedAt].filter(Boolean).sort(); return [null, all.length ? `latest ${agoText(src.now - Date.parse(all[all.length - 1]))}` : 'no changes recorded since the log started']; },
        body: async (src, ctx) => {
          const st = ctx.cfg.stamps || {};
          const rows = [['ESPN cookies', st.espnCookies], ['League Password', st.leaguePassword], ['Admin Password', st.adminPassword], ['Trade weighting', st.tradeWeights], ['Home page order', st.toolOrder],
            ['Fortune Teller switch', ctx.cfg.fortuneTeller && ctx.cfg.fortuneTeller.changedAt], ['Setup finished', ctx.cfg.setupCompletedAt]]
            .concat(TOOLS.map((t) => [`${t.name} visibility`, (st.toolVisibility || {})[t.key]]));
          return [B.table([['Setting'], ['Changed', 'n']], rows.map((r) => B.row([C.txt(r[0]), r[1] ? C.at(r[1]) : C.txt('not since the log started')]))),
            B.note('Who changed a setting is in the log: Recent administrator actions, below.')];
        },
      }),
      P('c-actions', 'Recent administrator actions', {
        live: true,
        sum: async (src) => { const e = latestEvents(src, "AND kind = 'admin'", 1)[0]; return [null, e ? `latest ${agoText(src.now - e.at)}` : 'none recorded yet']; },
        body: async (src) => {
          const rows = latestEvents(src, "AND kind = 'admin'", 20);
          return rows.length ? [{ t: 'feed', items: feedRows(rows, []) }] : [B.empty('No administrator actions recorded yet.')];
        },
      }),
      P('c-cookies', 'ESPN cookies', {
        live: true,
        sum: async (src, ctx) => (ctx.espn.failing ? ['bad', 'refused by ESPN'] : ['ok', 'accepted by ESPN']),
        body: async (src, ctx) => {
          const c = ctx.cfg;
          return [B.kv([['espn_s2', c.espnS2 ? C.hidden(`${c.espnS2.length} characters`) : C.txt('missing', null, 'bad')], ['SWID', c.swid ? C.hidden(/^\{[0-9A-Fa-f-]{36}\}$/.test(c.swid) ? 'well formed' : 'malformed') : C.txt('missing', null, 'bad')],
            ['Saved', (c.stamps || {}).espnCookies ? C.time(c.stamps.espnCookies) : C.txt('before the log started')],
            ['ESPN says', ctx.espn.failing ? C.pill('bad', 'refused', ctx.espn.since ? null : null) : C.pill('ok', 'accepted')], ['Refused since', ctx.espn.failing ? C.time(ctx.espn.since) : '—']]),
            ...(ctx.espn.failing ? [B.note('New cookies go in Site Configuration. Until then every signed-in dataset serves the copy it last stored.')] : [])];
        },
      }),
      P('c-weights', 'Trade weighting', {
        sum: async (src, ctx) => [null, `${TRADE_ROWS.filter((r) => ctx.cfg.tradeWeights && ctx.cfg.tradeWeights[r.id] != null && ctx.cfg.tradeWeights[r.id] !== r.w).length} of ${TRADE_ROWS.length} rows moved`],
        body: async (src, ctx) => weightsBody(ctx, true),
      }),
      P('c-repull', 'Re-pull', {
        sum: async (src, ctx) => { const miss = ctx.rows.filter((r) => r.state === 'missing' && r.tier !== 'probe').length; return [miss ? 'warn' : 'ok', miss ? `needed: ${miss} datasets never fetched` : 'not needed']; },
        body: async (src, ctx) => {
          const j = await src.jobs();
          const miss = ctx.rows.filter((r) => r.state === 'missing' && r.tier !== 'probe');
          return [B.kv([['League data', j.prime ? C.txt(j.prime.complete ? 'complete' : 'in progress', `${j.prime.done || 0} of ${j.prime.total || 0}`) : C.txt('no record')], ['Last league data pass', C.time(j.prime && j.prime.finishedAt)],
            ['Box-score history', j.history ? C.txt(j.history.complete ? 'complete' : 'in progress') : C.txt('not run')],
            ['Re-pull banner', miss.length ? C.pill('warn', 'showing') : C.txt('not needed')], ['Datasets checked for', C.txt(ctx.cfg.datasetsCheckedVersion || 'not yet')]])];
        },
      }),
    ],
  },

  'draft-helper': {
    settings: async (src) => { const s = await src.settings(); const d = s ? s.s.draftSettings || {} : {}; return [['Draft', d.date ? C.at(d.date, String(d.type || '').toLowerCase()) : '—'], ['Polling', C.txt('every 15 s for picks and rosters, 60 s for players and news')], ['Idle stop', C.txt('after 4 hours')]]; },
    panels: [
      P('d-draft', 'Draft', {
        sum: async (src) => { const d = await src.digest('draft_results'); const dd = d && d.draftDetail; return dd ? [dd.inProgress ? 'run' : 'ok', dd.drafted ? `complete: ${(dd.picks || []).length} picks` : dd.inProgress ? `in progress: ${(dd.picks || []).length} picks` : 'not started'] : [null, 'not stored yet']; },
        body: async (src) => {
          const d = await src.digest('draft_results'); const s = await src.settings();
          const dd = (d && d.draftDetail) || {}, ds = s ? s.s.draftSettings || {} : {};
          // The same plan Draft Helper draws its board from.
          const plan = draftPlan((d && d.settings) || (s && s.s) || null, dd.picks || []);
          const perTeam = plan.rounds;
          return [B.kv([['State', dd.drafted ? C.pill('ok', 'complete') : dd.inProgress ? C.pill('run', 'in progress') : C.pill('idle', 'not started')],
            ['Date', ds.date ? C.at(ds.date) : '—'], ['Type', C.txt(String(ds.type || '—').toLowerCase())], ['Order', C.txt(ds.orderType === 'MANUAL' ? 'set by the commissioner' : String(ds.orderType || '—').toLowerCase())],
            ['Time per pick', ds.timePerSelection ? C.txt(`${ds.timePerSelection} s`) : '—'], ['Keepers', C.n(ds.keeperCount || 0)],
            ['Rounds', C.n(perTeam || 0, plan.roundsFrom === 'picks' ? 'from the picks' : plan.roundsFrom === 'roster' ? 'the roster\'s size' : 'assumed')], ['Board', C.txt(plan.snake ? 'snake' : 'straight', plan.order.length ? `${plan.order.length} teams in order` : 'order not set yet')], ['Picks', C.txt(`${(dd.picks || []).length} of ${perTeam && s ? perTeam * (s.s.size || 0) : '?'}`)],
            ['Finished', dd.completeDate ? C.at(dd.completeDate) : '—']])];
        },
      }),
      P('d-rules', 'Roster rules', {
        sum: async (src) => { const s = await src.settings(); return [s ? 'ok' : null, s ? 'read from the league\'s settings' : 'league settings not stored yet']; },
        body: async (src) => rosterRulesBody(src),
      }),
      P('d-poll', 'Polling', {
        live: true,
        sum: async () => [null, '5 datasets, answered "not modified" when unchanged'],
        body: async (src) => {
          const rows = (await src.hours(48)).filter((r) => r.hour >= hourOf(day0Of(src)));
          const list = [['draft_results', 15], ['rosters', 15], ['player_digest', 60], ['injuries_digest', 60], ['nfl_news', 60]];
          return [B.table([['Dataset'], ['Every', 'n'], ['Requests today', 'n'], ['Not modified', 'n']], list.map(([k, e]) => {
            const s = routeStats(rows, 'GET', `/api/data/${k}`);
            return B.row([C.code(k), C.txt(e ? `${e} s` : 'once'), C.n(s.n), C.n(s.nm)]);
          })), B.note('Each poll sends the version it already has; an unchanged dataset answers "not modified" with no body. Polling stops after four hours without a tap.')];
        },
      }),
    ],
  },

  'live-matchups': {
    settings: async () => [['Past weeks kept', C.txt('every week of the season')], ['Polling', C.txt('every 15 s for scores, 60 s for charts')], ['Idle stop', C.txt('after 4 hours')]],
    panels: [
      P('l-week', 'This week\'s matchups', { live: true, sum: async (src) => { const l = await src.digest('live_scoring_digest'); if (!l) return [null, 'not stored yet']; const g = l.games || []; return [g.some((x) => x.state === 'live') ? 'run' : null, `${g.filter((x) => x.state !== 'pre').length} of ${g.length} under way`]; }, body: (src) => matchupRows(src, true) }),
      P('l-windows', 'Game windows this week', {
        live: true,
        sum: async (src, ctx) => (ctx.window.open ? ['run', 'a window is open'] : [null, ctx.window.next ? `next ${agoText(ctx.window.next - src.now, true)}` : 'none scheduled']),
        body: async (src) => {
          const b = await src.digest('scoreboard_digest');
          const by = new Map();
          for (const g of (b && b.games) || []) { const k = Date.parse(g.kickoff || ''); if (!Number.isFinite(k)) continue; by.set(k, (by.get(k) || []).concat(g)); }
          const now = src.now;
          const rows = [...by.keys()].sort((a, c) => a - c).map((k) => {
            const gs = by.get(k);
            const open = gs.some((g) => !g.final) && now >= k - 2 * 60000 && now <= k + 4.5 * 3600000;
            const done = gs.every((g) => g.final);
            return B.row([C.at(k), C.txt(gs.map((g) => `${g.away} at ${g.home}`).join(', ')), C.n(gs.length),
              open ? C.pill('run', 'recording') : done ? C.pill('idle', 'done') : k > now ? C.pill('ok', 'upcoming') : C.pill('idle', 'closed')], open ? 'run' : null);
          });
          return rows.length ? [B.table([['Kickoff'], ['Games'], ['Count', 'n'], ['Timeline']], rows),
            B.note('A window runs from two minutes before a kickoff until four and a half hours after it; the timeline records only inside one.')] : [B.empty('The NFL scoreboard has not been stored yet.')];
        },
      }),
      P('l-live', 'Live scoring and timeline', {
        live: true,
        sum: async (src, ctx) => (ctx.window.open ? ['run', 'a game window is open'] : [null, 'no game window']),
        body: async (src, ctx) => { const { OVERVIEW } = await import('./sbover.js'); return OVERVIEW.find((x) => x.id === 'p-livescore').body(src, ctx); },
      }),
      P('l-weeks', 'Past weeks', {
        sum: async (src) => { const list = ((await src.dataList()) || {}).live_scoring_digest || []; const n = list.filter((o) => /^w\d+$/.test(o.part)).length; return [null, `${n} week${n === 1 ? '' : 's'} stored`]; },
        body: async (src, ctx) => {
          const list = (((await src.dataList()) || {}).live_scoring_digest || []).filter((o) => /^w\d+$/.test(o.part)).sort((a, b) => Number(a.part.slice(1)) - Number(b.part.slice(1)));
          const weeks = ctx.timelineWeeks || [];
          if (!list.length && !weeks.length) return [B.empty('No past week has been opened yet: each is stored the first time someone views it.')];
          const all = new Set([...list.map((o) => Number(o.part.slice(1))), ...weeks.map((w) => w.week)]);
          return [B.table([['Week', 'n'], ['Stored digest', 'n'], ['Stored', 'n'], ['Timeline', 'n']], [...all].sort((a, b) => a - b).map((w) => {
            const o = list.find((x) => x.part === `w${w}`);
            const t = weeks.find((x) => x.week === w);
            return B.row([C.n(w), o ? C.bytes(o.size) : '—', o ? C.time(o.uploaded) : '—', t ? C.bytes(t.bytes) : '—']);
          }))];
        },
      }),
      P('l-rules', 'Timeline rules', {
        sum: async () => [null, `96 KB per week, ${MAX_EVENTS.toLocaleString('en-US')} events`],
        body: async () => [B.kv([['Records', C.txt('score, projection and win chance, together')], ['Only when', C.txt(`one of them moves by ${MIN_DELTA} or more`)],
          ['At most', C.txt(`one row every ${MIN_GAP_MS / 1000} s per matchup`)], ['Budget', C.bytes(BYTE_BUDGET, 'per week, trimmed by measured bytes')],
          ['Scoring events', C.txt(`up to ${MAX_EVENTS.toLocaleString('en-US')} a week`)], ['Past weeks', C.txt('kept all season, one object per week')]])],
      }),
      P('l-poll', 'Polling', { live: true, sum: async (src) => { const o = openTabs(await src.hours(48), '/api/live/week', 15); return [null, `${o || 0} tab${o === 1 ? '' : 's'} open now`]; }, body: polling([['/api/live/week', 15], ['/api/live/timeline', 60], ['/api/live/h2h', null]]) }),
    ],
  },

  'hall-of-fame': {
    settings: async (src, ctx) => [['History seasons', C.txt((ctx.cfg.historySeasons || []).join(', ') || 'none', 'discovered at setup')]],
    panels: [
      P('f-seasons', 'Seasons', {
        sum: async (src) => { const h = await src.digest('league_history_digest'); const n = h ? Object.keys(h.seasonMeta || {}).length : 0; return [null, h ? `${n} seasons` : 'not stored yet']; },
        body: async (src) => {
          const h = await src.digest('league_history_digest');
          if (!h) return [B.empty('The record book has not been built yet.')];
          const champ = new Map((h.champions || []).map((c) => [c.year, c]));
          return [B.table([['Season', 'n'], ['Teams', 'n'], ['Playoff places', 'n'], ['Champion']], Object.entries(h.seasonMeta || {}).sort((a, b) => b[0] - a[0]).map(([y, m]) => {
            const c = champ.get(Number(y));
            return B.row([C.txt(String(y)), C.n(m.size), C.n(m.playoffTeamCount), m.inProgress || !c || c.placeholder ? C.txt('in progress') : C.team(c.teamId)]);
          })), B.note('Champions are shown under each team\'s current name.')];
        },
      }),
      P('f-records', 'Records tracked', {
        sum: async (src) => { const h = await src.digest('league_history_digest'); return [null, h ? `${Object.keys(h.records || {}).length} records` : 'not stored yet']; },
        body: async (src) => {
          const h = await src.digest('league_history_digest');
          if (!h) return [B.empty('The record book has not been built yet.')];
          return [B.table([['Record'], ['Holders', 'n']], Object.entries(h.records || {}).map(([k, v]) => B.row([C.txt(k.replace(/([A-Z])/g, ' $1').replace(/^./, (x) => x.toUpperCase()).toLowerCase().replace(/^./, (x) => x.toUpperCase())), C.n(Array.isArray(v) ? v.length : 1)]))),
            B.note('Where several teams share a record, all of them hold it.')];
        },
      }),
      P('f-h2h', 'Head-to-head', {
        sum: async (src) => { const h = await src.digest('h2h_full_digest'); return [null, h ? `${h.pairCount} pairs over ${h.seasons} seasons` : 'not stored yet']; },
        body: async (src, ctx) => { const h = await src.digest('h2h_full_digest'); const r = ctx.rowByKey.h2h_full_digest; return h ? [B.kv([['Pairs', C.n(h.pairCount)], ['Seasons', C.n(h.seasons)], ['This season included', C.txt(h.currentSeasonIncluded ? 'yes' : 'no')], ['Digest', C.bytes(r ? r.bytes : 0)], ['Built', C.time(h.generatedAt)]])] : [B.empty('Not built yet.')]; },
      }),
      P('f-job', 'Box-score history job', { sum: historySum, body: historyBody }),
    ],
  },

  'trade-analyzer': {
    settings: async (src) => { const s = await src.settings(); const tr = s ? s.s.tradeSettings || {} : {}; return [['Trade deadline', tr.deadlineDate ? C.at(tr.deadlineDate) : '—'], ['Weighting', C.txt('the league\'s own, from Site Configuration')]]; },
    panels: [
      P('t-offers', 'Offers', {
        live: true,
        sum: async (src) => { const t = await src.digest('trade_digest'); return [null, t ? `${(t.pending || []).length} on the table` : 'not stored yet']; },
        body: async (src) => {
          const t = await src.digest('trade_digest'); const tx = await src.digest('transaction_digest');
          const by = {};
          for (const it of (tx && tx.items) || []) if (it.kind === 'trade' && it.status !== 'on_the_table') by[it.status || 'unknown'] = (by[it.status || 'unknown'] || 0) + 1;
          return [B.kv([['On the table', C.n(t ? (t.pending || []).length : 0)], ...Object.entries(by).map(([k, n]) => [TRADE_STATUS[k] || k.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()), C.n(n)])]),
            B.note('Counts only: which teams are involved is never shown here.')];
        },
      }),
      P('t-rules', 'League trade rules', {
        sum: async (src) => { const s = await src.settings(); const d = s && s.s.tradeSettings && s.s.tradeSettings.deadlineDate; return [null, d ? `deadline ${agoText(d - src.now, d > src.now)}` : 'not stored yet']; },
        body: async (src) => {
          const s = await src.settings(); if (!s) return [B.empty('League settings not stored yet.')];
          const tr = s.s.tradeSettings || {}, aq = s.s.acquisitionSettings || {};
          return [B.kv([['Trade deadline', tr.deadlineDate ? C.at(tr.deadlineDate) : '—'], ['Votes to veto', C.n(tr.vetoVotesRequired ?? 0)], ['Review period', C.txt(`${tr.revisionHours ?? '?'} hours`)],
            ['Trades per team', C.txt(tr.max == null || tr.max < 0 ? 'no limit' : String(tr.max))], ['Waivers', C.txt(String(aq.acquisitionType || '').toLowerCase().replace(/_/g, ' '), aq.waiverHours ? `${aq.waiverHours} hours` : null)],
            ['Budget', C.txt(aq.isUsingAcquisitionBudget ? `$${aq.acquisitionBudget}` : 'none')]])];
        },
      }),
      P('t-model', 'Model', {
        sum: async () => [null, `engine ${TA.ENGINE_VERSION}; ${TRADE_ROWS.length} rows`],
        body: async () => [B.kv([['Engine', C.code(TA.ENGINE_VERSION)], ['Rows', C.n(TRADE_ROWS.length, `${TRADE_ROWS.filter((r) => r.s).length} with sliders`)],
          ['Balance suggestions', C.txt(`up to ${TA.BALANCE_SUGGESTIONS}, once the gap passes ${Math.round(TA.BALANCE_HELP_BAND * 100)}%`)], ['Bench value', C.txt(`discounted ${Math.round(TA.BENCH_DISCOUNT * 100)}%`)],
          ['Lopsided', C.txt(`one side gives ${TA.LOPSIDED_RATIO} times the other`)], ['Offer expiring soon', C.txt(`within ${TA.OFFER_SOON_HOURS} hours`)],
          ['Value of certain playoff odds', C.txt(`${TA.ODDS_VP} points`)], ['Value of a title', C.txt(`${TA.TITLE_VP} points`)]]),
          B.split([B.sub('Verdict bands (share of the larger side)'), B.table([['Verdict'], ['Gap']], TA.BANDS.map((b, i) => B.row([C.txt(b.label), C.txt(b.max === Infinity ? `beyond ${Math.round(TA.BANDS[i - 1].max * 100)}%` : `up to ${Math.round(b.max * 100)}%`)])))],
            [B.sub('Replacement level where the league\'s free agents are not stored, season points'), B.table([['Position'], ['Points', 'n']], Object.entries(TA.REPLACEMENT).map(([k, v]) => B.row([C.txt(k), C.n(v)])))])],
      }),
      P('t-odds', 'Playoff odds fit', {
        sum: async (src) => { const st = await src.digest('standings_digest'); const s = await src.settings(); if (!st) return [null, 'not stored yet']; const sum = (st.rows || []).reduce((a, r) => a + (typeof r.playoffPct === 'number' ? r.playoffPct : 0), 0); const places = s && s.s.scheduleSettings ? s.s.scheduleSettings.playoffTeamCount : 0; const ok = places && Math.abs(sum - places) <= 0.15 * places; return [ok ? 'ok' : 'warn', ok ? 'ESPN\'s odds add up; the fit is in use' : 'ESPN\'s odds do not add up; the fit falls back']; },
        body: async (src) => {
          const st = await src.digest('standings_digest'); const s = await src.settings();
          if (!st) return [B.empty('Standings not stored yet.')];
          const sum = (st.rows || []).reduce((a, r) => a + (typeof r.playoffPct === 'number' ? r.playoffPct : 0), 0);
          const places = s && s.s.scheduleSettings ? s.s.scheduleSettings.playoffTeamCount : 0;
          return [B.kv([['ESPN\'s odds add up to', C.txt(sum.toFixed(2), `of ${places} places`)], ['Used for the odds fit', Math.abs(sum - places) <= 0.15 * places ? C.pill('ok', 'yes') : C.pill('warn', 'no, falls back')]]),
            B.table([['Team'], ['Playoff %', 'n']], st.rows.slice().sort((a, b) => (b.playoffPct || 0) - (a.playoffPct || 0)).map((r) => B.row([C.team(r.teamId), typeof r.playoffPct === 'number' ? C.pct(r.playoffPct) : '—']))),
            B.note('The analyzer fits playoff odds to lineup strength from these figures, so a trade can be valued in playoff odds.')];
        },
      }),
      P('t-weights', 'League weighting', {
        sum: async (src, ctx) => [null, `${TRADE_ROWS.filter((r) => ctx.cfg.tradeWeights && ctx.cfg.tradeWeights[r.id] != null && ctx.cfg.tradeWeights[r.id] !== r.w).length} of ${TRADE_ROWS.length} rows moved`],
        body: async (src, ctx) => weightsBody(ctx, false),
      }),
      P('t-digest', 'What the analyzer reads', {
        live: true,
        sum: async (src, ctx) => { const r = ctx.rowByKey.trade_digest; return [null, r && r.newest ? `built ${agoText(src.now - Date.parse(r.newest))}` : 'not built yet']; },
        body: async (src, ctx) => {
          const t = await src.digest('trade_digest'); const r = ctx.rowByKey.trade_digest;
          if (!t) return [B.empty('Not built yet.')];
          return [B.kv([['Built from', C.code('pending_transactions')], ['Also needs', C.txt(([].concat(DERIVATIONS.pending_transactions)[0].needs || []).join(', '))], ['Size', C.bytes(r ? r.bytes : 0)],
            ['Built', C.time(t.generatedAt)], ['Teams', C.n((t.teams || []).length)], ['Roster cap', C.n(t.rosterCap || 0)], ['Offers carried', C.n((t.pending || []).length)]]),
            B.note('Pending waiver claims share the same response from ESPN and are dropped before anything is stored.')];
        },
      }),
      P('t-links', 'Share links', {
        live: true,
        sum: async (src) => [null, `${countEvents(src, src.now - 7 * DAY, "AND page = 'trade-analyzer' AND text LIKE 'Shared%'").n} shared in 7 days`],
        body: async (src) => [B.kv([['Shared, 7 days', C.n(countEvents(src, src.now - 7 * DAY, "AND page = 'trade-analyzer' AND text LIKE 'Shared%'").n)],
          ['Shared links opened, 7 days', C.n(countEvents(src, src.now - 7 * DAY, "AND page = 'trade-analyzer' AND text LIKE 'Opened a shared%'").n)]]),
          B.note(`Counts only; the log never says which teams or players a link held. A shared link is recognised by its ${SHARE_PARAMS['trade-analyzer'].join(' or ')} parameter.`)],
      }),
    ],
  },

  'fortune-teller': {
    settings: async (src, ctx) => [['Switch', C.txt(ctx.cfg.fortuneTeller && ctx.cfg.fortuneTeller.enabled ? 'on' : 'off', ctx.cfg.fortuneTeller && ctx.cfg.fortuneTeller.changedAt ? `changed ${agoText(src.now - Date.parse(ctx.cfg.fortuneTeller.changedAt))}` : null)],
      ['Changed from', C.txt('Site Configuration')]],
    panels: ftPanels(),
  },

  'llm-export': {
    settings: async () => [['Free-agent depth', C.txt(Object.entries(FREE_AGENT_DEPTH).map(([k, v]) => `${v} ${k}`).join(', '), `compact ${Object.entries(COMPACT_FREE_AGENT_DEPTH).map(([k, v]) => `${v} ${k}`).join(', ')}`)],
      ['Refreshed before a copy or download', C.txt('when older than 45 s')]],
    panels: [
      P('e-export', 'Export', {
        live: true,
        sum: async (src, ctx) => { const r = ctx.rowByKey.llm_export_digest; return [null, r && r.bytes ? `${fmtB(r.bytes)} full` : 'not built yet']; },
        body: async (src, ctx) => {
          const d = await src.digest('llm_export_digest'); const r = ctx.rowByKey.llm_export_digest;
          if (!d || !d.export) return [B.empty('The export has not been built yet.')];
          const compact = JSON.stringify(compactExport(d.export)).length;
          const d0 = day0Of(src);
          return [B.kv([['Full', C.bytes(r ? r.bytes : 0)], ['Compact', C.bytes(compact)], ['Sections', C.n(Object.keys(d.export).length)],
            ['Exports today', C.n(countEvents(src, d0, "AND page = 'llm-export' AND kind = 'operation'").n)], ['Built', C.time(d.generatedAt)]])];
        },
      }),
      P('e-sections', 'Sections', {
        sum: async (src) => { const d = await src.digest('llm_export_digest'); return [null, d && d.export ? `${Object.keys(d.export).length}, in a fixed order` : 'not built yet']; },
        body: async (src) => {
          const d = await src.digest('llm_export_digest');
          if (!d || !d.export) return [B.empty('Not built yet.')];
          const c = compactExport(d.export);
          return [B.table([['Section'], ['Full', 'n'], ['Compact', 'n']], Object.keys(d.export).map((k) => B.row([C.code(k), C.bytes(JSON.stringify(d.export[k]).length), c[k] !== undefined ? C.bytes(JSON.stringify(c[k]).length) : C.txt('left out')]))),
            B.note('Always in this order. The prompt describes only the sections actually present, so the compact file gets a compact prompt.')];
        },
      }),
      P('e-fa', 'Free-agent shortlist', {
        sum: async (src) => { const d = await src.digest('llm_export_digest'); const n = d && d.export && d.export.freeAgents ? (d.export.freeAgents.players || []).length : 0; return [null, `${n} players in the full file`]; },
        body: async (src) => {
          const d = await src.digest('llm_export_digest');
          const players = (d && d.export && d.export.freeAgents && d.export.freeAgents.players) || [];
          const by = {}; for (const p of players) by[p.pos] = (by[p.pos] || 0) + 1;
          return [B.table([['Position'], ['Depth', 'n'], ['In the file', 'n'], ['Compact', 'n']], Object.entries(FREE_AGENT_DEPTH).map(([k, v]) => B.row([C.txt(k), C.n(v), C.n(by[k] || 0), C.n(COMPACT_FREE_AGENT_DEPTH[k] || 0)]))),
            B.note('Ordered by ESPN\'s rest-of-season projection.')];
        },
      }),
      P('e-never', 'Never in the file', {
        sum: async (src) => { const r = await neverChecks(src); const f = r.filter((x) => !x[0]).length; return [r.length ? (f ? 'bad' : 'ok') : null, r.length ? `${r.length - f} of ${r.length} hold` : 'not built yet']; },
        body: async (src) => { const r = await neverChecks(src); return r.length ? [B.checks(r), B.note('Checked against the stored file on every look: the league ID, every owner\'s name and the ESPN cookies are searched for.')] : [B.empty('Not built yet.')]; },
      }),
      P('e-files', 'Files handed over', {
        live: true,
        sum: async (src) => [null, `${countEvents(src, src.now - 7 * DAY, "AND page = 'llm-export' AND kind = 'operation'").n} in 7 days`],
        body: async (src) => {
          const c = (w) => C.n(countEvents(src, src.now - 7 * DAY, `AND page = 'llm-export' AND kind = 'operation' ${w}`).n);
          return [B.kv([['Copied, 7 days', c("AND text LIKE '%copy%'")], ['Downloaded, 7 days', c("AND text LIKE '%download%'")], ['Full', c("AND text LIKE '%full%'")], ['Compact', c("AND text LIKE '%compact%'")]])];
        },
      }),
    ],
  },

  'site-api': {
    settings: async (src) => {
      const sa = normaliseSiteApi((await src.cfg()).siteApi);
      return [['API', C.pill(sa.on ? 'ok' : 'idle', sa.on ? 'on' : 'off')], ['Replaced', C.txt(sa.interval === 'season' ? 'at Season End' : `every ${sa.interval} days`)],
        ['Key in the address', C.txt(sa.inAddress ? 'allowed' : 'refused')]];
    },
    // Site API's own panels live in src/sbapi.js: High activity, API status, Pace, Snapshot, Rate window, Sources,
    // Use, Jobs, Refusals, Old key still in use and Cost.
    panels: SITE_API_PANELS,
  },

  'site-backend': {
    settings: async () => [['Refresh', C.txt('every 15 s while open')], ['Idle stop', C.txt('after 4 hours')], ['Recording', C.txt('always on, whatever this tool\'s visibility')]],
    panels: [
      P('b-cost', 'What this tool costs', {
        live: true,
        sum: async (src) => { const rows = (await src.hours(48)).filter((r) => r.hour >= utcMidnight(src.now)); return [null, `${routeStats(rows, 'GET', '/apps/site-backend/api').n} refreshes today`]; },
        body: async (src) => {
          const rows = (await src.hours(48)).filter((r) => r.hour >= utcMidnight(src.now));
          const s = routeStats(rows, 'GET', '/apps/site-backend/api');
          const c = await src.census();
          return [B.kv([['Refreshes today', C.n(s.n, s.med != null ? `median ${s.med} ms` : null)], ['Each refresh', C.txt('1 Worker request and 1 log request, plus reads')],
            ['Census', c ? C.time(c.at, 'every 10 minutes') : C.txt('not yet')], ['Log store', C.bytes(src.deps.size(), 'of 1 GB; condensing starts at 750 MB')]])];
        },
      }),
      P('b-rec', 'Recording', {
        sum: async () => ['ok', 'always on'],
        body: async () => [B.kv([['Recording', C.pill('ok', 'always on')], ['Whatever this tool\'s visibility', C.txt('yes, hidden included')], ['Identity kept', C.txt('the team chosen on that browser, nothing else')],
          ['Writes', C.txt('batched: events after each response, counters at most once a minute per isolate')], ['Started', C.txt('when setup finished; setup itself is read from its own records')]])],
      }),
      P('b-log', 'Log store', {
        live: true,
        sum: async (src) => [null, `${fmtB(src.deps.size())} of 1 GB`],
        body: async (src) => {
          const kinds = Object.entries(src.deps.meta('kinds', {}) || {}).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n);
          const reps = src.deps.q('SELECT MAX(id) AS n FROM reports')[0].n || 0;
          const first = src.deps.q('SELECT MIN(at) AS at FROM events')[0].at;
          const m = src.meter();
          return [B.split([B.table([['Kind'], ['Entries this season', 'n']], kinds.map((r) => B.row([C.txt(r.kind), C.n(r.n)])).concat([B.row([C.txt('hourly status'), C.n(reps)])]))],
            [B.kv([['Store', C.code(`site-log-${src.facts.season || ''}`)], ['Size', C.bytes(src.deps.size(), 'of 1 GB')], ['Condensing starts', C.txt('at 750 MB')],
              ['Oldest entry', first ? C.time(first) : '—'], ['Rows written today', C.n(m.rows, `of a ${m.budget.rows.toLocaleString('en-US')} budget`)], ['Requests today', C.n(m.req, `of ${m.budget.requests.toLocaleString('en-US')}`)],
              ['Kept', C.txt('for good; each season is its own store')]])])];
        },
      }),
      P('b-reads', 'What each refresh reads', {
        sum: async () => [null, 'no ESPN calls, no dataset refreshes'],
        body: async () => [B.table([['Each 15 s refresh reads'], ['Cost']], [
          ['Only what open panels show, plus every summary line', '1 Worker request'], ['The site log', '1 Durable Object request'],
          ['Fortune Teller, through its read-only route', '1 Durable Object request, when a Fortune Teller panel is open'], ['Dataset listings', '2 R2 lists, shared between viewers for 15 s'],
          ['Storage census', 'every 10 minutes, not per refresh'], ['ESPN', 'never'], ['Dataset refreshes', 'never'],
        ].map((r) => B.row([C.txt(r[0]), C.txt(r[1])])))],
      }),
    ],
  },
};

function historySum(src) {
  return src.jobs().then((j) => { const h = j.history; return [h ? (h.complete ? 'ok' : 'run') : null, h ? (h.complete ? `complete: ${h.eventsDone || 0} box scores` : `in progress: ${h.eventsDone || 0} of ${h.eventsTotal || 0}`) : 'not run']; });
}
async function historyBody(src) {
  const h = (await src.jobs()).history;
  if (!h) return [B.empty('The box-score history job has not run on this deployment. It runs from setup, or from Site Configuration.')];
  return [B.kv([['Box scores', C.txt(`${h.eventsDone || 0} of ${h.eventsTotal || 0}`, h.complete ? 'complete' : 'in progress')], ['Seasons', C.txt((h.seasons || []).join(', '))],
    ['Per call', C.txt('24 weeks or 8 box scores')], ['At once', C.txt('5 weeks or 3 box scores')], ['Tries per item', C.txt('3')],
    ['Failures recorded', C.n((h.failures || []).length, 'keeps up to 60')], ['Started', C.time(h.startedAt)], ['Finished', C.time(h.finishedAt)]])];
}

function weightsBody(ctx, movedOnly) {
  const w = ctx.cfg.tradeWeights || {};
  const rows = TRADE_ROWS.filter((r) => !movedOnly || (w[r.id] != null && w[r.id] !== r.w));
  if (!rows.length) return [B.empty('Every row uses the shipped default.')];
  return [B.table([['Row'], ['Group'], ['Slider'], ['Default', 'n'], ['League', 'n']], rows.map((r) => {
    const moved = w[r.id] != null && w[r.id] !== r.w;
    return B.row([C.mix(C.code(r.id), C.txt(` ${r.n}`)), C.txt(TRADE_GROUPS[r.g] || r.g), C.txt(r.s ? 'yes' : ''), C.txt(String(r.w)), C.txt(String(moved ? w[r.id] : r.w), null, moved ? 'acc' : null)], moved ? 'run' : null);
  })), B.note('Only rows moved away from the default are kept.')];
}

/** The lineup Draft Helper draws, from the same module it uses: what the page shows is what the tool applies. */
async function rosterRulesBody(src) {
  const s = await src.settings();
  if (!s) return [B.empty('League settings not stored yet.')];
  const shape = rosterShape(s.s);
  const counts = new Map();
  for (const slot of shape.starters) counts.set(slot, (counts.get(slot) || 0) + 1);
  const ir = Number(((s.s.rosterSettings || {}).lineupSlotCounts || {})[21] || 0);
  const lineup = [...counts.entries()].map(([k, n]) => B.row([C.txt(k, shape.flex[k] ? shape.flex[k].join(', ') : null), C.n(n)]))
    .concat([B.row([C.txt('Bench'), C.n(shape.bench)])], ir ? [B.row([C.txt('IR'), C.n(ir)])] : []);
  const limits = Object.entries(shape.limits);
  return [B.split([B.sub('Lineup'), B.table([['Slot'], ['Count', 'n']], lineup)],
    [B.sub('Most of one position a team may roster'), limits.length ? B.table([['Position'], ['Limit', 'n']], limits.map(([k, n]) => B.row([C.txt(k), C.n(n)]))) : B.empty('The league sets no limit on any position.')]),
  B.note(shape.source === 'league' ? 'Draft Helper reads these from the league\'s settings, so a league shaped differently gets its own needs and targets.' : 'The league\'s settings did not say, so Draft Helper uses a standard lineup.')];
}

async function neverChecks(src) {
  const d = await src.digest('llm_export_digest');
  if (!d || !d.export) return [];
  const text = JSON.stringify(d.export);
  const cfg = await src.cfg();
  const lt = await src.digest('league_teams');
  const owners = ((lt && lt.members) || []).map((m) => `${m.firstName || ''} ${m.lastName || ''}`.trim()).filter((n) => n.length > 3);
  const pending = await src.digest('pending_transactions');
  const claims = ((pending && pending.transactions) || []).filter((t) => /WAIVER/.test(t.type || ''));
  return [
    [!owners.some((o) => text.includes(o)), 'No owner names or account ids'],
    [!claims.some((c) => text.includes(String(c.id))), 'No pending waiver claims'],
    [!/\/api\/logo\//.test(text), 'No logos inside the file (they travel beside it)'],
    [!(cfg.leagueId && text.includes(String(cfg.leagueId))), 'No league ID'],
    [!((cfg.espnS2 && text.includes(cfg.espnS2)) || (cfg.swid && text.includes(cfg.swid))), 'Nothing from the ESPN session'],
  ];
}

// ---------------------------------------------------------------- Fortune Teller

function ftPanels() {
  const peekJob = (p) => (p && p.job) || null;
  return [
    P('ft-pipe', 'Pipeline', {
      live: true,
      sum: async (src, ctx) => (ctx.ftp ? [ftSev(ctx.ftp.state), `${ctx.ftp.state}${ctx.ftp.state === 'early' && ctx.ftp.opensAfterWeek ? `: opens after week ${ctx.ftp.opensAfterWeek}` : ''}`] : [null, 'no check yet']),
      body: async (src, ctx) => {
        const p = ctx.ftp;
        if (!p) return [B.empty('The pipeline has not run a check yet. It checks every 15 minutes once setup has finished.')];
        const sum = await src.ftSummary();
        return [B.kv([['State', C.pill(ftSev(p.state), p.state)], ['Switched on', C.txt(p.enabled ? 'yes' : 'no')], ['Last check', C.time(p.checkedAt, p.reason || null)],
          ['Next check', C.time(Math.floor(src.now / 900000) * 900000 + 900000)], ['Weeks settled', C.txt(`${p.lastSettled ?? '?'} of ${p.mpc ?? '?'}`)],
          ['Opens after', p.opensAfterWeek ? C.txt(`week ${p.opensAfterWeek}`, `when ${(p.mpc || 0) - p.opensAfterWeek} weeks are left`) : '—'],
          ['A build now', p.estimate ? C.txt(`${fmtPaths(p.estimate.paths)} paths`, aboutHours(p.estimate.hours)) : '—'],
          ['Attempts', C.txt(`${p.attempts || 0} of 3`, 'failures retry an hour apart')], ['Tree', p.tree ? C.txt('built', p.thru != null ? `through week ${p.thru}` : null) : C.txt('none yet')],
          ['What members see', C.txt(sum ? 'the simulation' : 'the page before the simulation: ESPN\'s odds and brackets')],
          p.error ? ['Last error', C.txt(String(p.error).slice(0, 120), null, 'bad')] : null])];
      },
    }),
    P('ft-build', 'Build', {
      live: true,
      sum: async (src) => { const j = peekJob(await src.ftPeek()); return j && ['queued', 'running', 'paused'].includes(j.state) ? ['run', `${j.kind || 'build'} ${j.state}, team ${(j.team || 0) + 1} of ${j.n}`] : [null, j ? `last: ${j.kind || 'build'} ${j.state}` : 'no build yet']; },
      body: async (src) => {
        const pk = await src.ftPeek(); const j = peekJob(pk);
        if (!j) return [B.empty('No build has run yet. The first starts by itself once a build fits, or when an administrator asks for a rebuild in Site Configuration.')];
        const parts = j.parts || 1;
        const done = ((j.team || 0) + (j.next === 'team' ? (j.chunk || 0) / parts : j.next === 'merge' ? 0.9 : 0)) / Math.max(1, j.n || 1);
        return [B.kv([['Kind', C.txt(j.kind || 'build')], ['State', C.pill(j.state === 'failed' ? 'bad' : j.state === 'done' ? 'ok' : j.state === 'paused' ? 'warn' : 'run', j.state, j.pauseReason || null)],
          ['Step', C.txt(j.next || '—')], ['Team', C.txt(`${Math.min((j.team || 0) + 1, j.n || 0)} of ${j.n || 0}`)], ['Part', j.parts > 1 ? C.txt(`${(j.chunk || 0) + 1} of ${j.parts}`) : '—'],
          ['Paths', j.paths ? C.txt(fmtPaths(j.paths)) : '—'], ['Started', C.time(j.startedAt)], ['Finished', C.time(j.finishedAt)], ['Slices run', C.n(j.slices || 0)],
          ['Next alarm', pk.alarm ? C.time(pk.alarm) : C.txt('none set')], j.error ? ['Error', C.txt(String(j.error).slice(0, 120), null, 'bad')] : null]),
          ...(['queued', 'running', 'paused'].includes(j.state) ? [B.progress(Math.min(1, done))] : [])];
      },
    }),
    P('ft-gov', 'Governor', {
      live: true,
      sum: async (src) => { const pk = await src.ftPeek(); if (!pk || !pk.governor) return [null, 'not read yet']; const u = pk.governor.used || {}; const w = Math.max(u.requests || 0, u.gbs || 0, u.rows || 0); return [pk.governor.ok ? 'ok' : 'warn', pk.governor.ok ? `${(w * 100).toFixed(1)}% of today's allowance used` : `holding: ${pk.governor.reason}`]; },
      body: async (src, ctx) => {
        const pk = await src.ftPeek();
        if (!pk) return [B.empty('The build object could not be read.')];
        const g = pk.governor || {}, m = pk.meter || {}, c = pk.config || FT_DEFAULTS;
        const pct = Math.max(1, Math.min(100, c.allowancePct)) / 100;
        return [B.kv([['Now', g.ok ? C.pill('ok', 'free to run') : C.pill('warn', 'holding', g.reason || null)], ['Holds until', g.until ? C.time(g.until) : '—'],
          ['Released so far today', C.pct(g.pace ?? 1)], ['Game gate', C.txt(c.gameGate ? (ctx.window.open ? 'on: a game window is open' : 'on: no game window now') : 'off')], ['Resets', C.time(utcMidnight(src.now) + DAY)]]),
          B.sub(`Today's meter, against ${Math.round(pct * 100)}% of each free daily limit`),
          { t: 'gauges', items: [
            { label: 'Alarms (Durable Object requests)', used: m.alarms || 0, limit: Math.round(100000 * pct) },
            { label: 'Duration (GB-seconds)', used: Math.round(((m.wallMs || 0) / 1000) * 0.125), limit: Math.round(13000 * pct) },
            { label: 'Rows written', used: m.rows || 0, limit: Math.round(100000 * pct) },
          ] },
          B.sub('Settings'),
          B.kv([['Allowance', C.txt(`${c.allowancePct}% of each daily limit`)], ['Slice gap', C.txt(`${c.sliceGapMs} ms`)], ['Target slice', C.txt(`${c.targetSliceMs / 1000} s`)],
            ['Pace floor', C.txt(String(c.paceFloor))], ['Burst', C.txt(c.burst ? `from ${c.burstHour}:00 UTC` : 'off')], ['Game gate', C.txt(c.gameGate ? 'on' : 'off')],
            ['Activate on finish', C.txt(c.activateOnFinish ? 'on' : 'off')], ['Cost per path', C.txt(`${c.nsFast} ns points, ${(c.nsH2h / 1000).toFixed(1)} µs head-to-head, ${(c.nsDiv / 1000).toFixed(1)} µs divisions`)]])];
      },
    }),
    P('ft-slices', 'Slice timings', {
      live: true,
      sum: async (src) => { const j = peekJob(await src.ftPeek()); const v = (j && j.sliceMs) || []; if (!v.length) return [null, 'no slices yet']; const over = v.filter((x) => x > 10000).length; return [over ? 'warn' : 'ok', over ? `${over} of the last ${v.length} over the 10 s target` : `all of the last ${v.length} under the 10 s target`]; },
      body: async (src) => {
        const j = peekJob(await src.ftPeek()); const v = (j && j.sliceMs) || [];
        if (!v.length) return [B.empty('No slices yet. Once a build runs, each slice\'s duration is drawn here against the 10 s target and the 30 s limit.')];
        const sorted = v.slice().sort((a, b) => a - b);
        return [{ t: 'slices', v }, B.kv([['Median', C.dur(sorted[Math.floor(sorted.length / 2)])], ['Longest', C.dur(sorted[sorted.length - 1])], ['Slices shown', C.txt(`last ${v.length}`)]])];
      },
    }),
    P('ft-rec', 'Recovery', {
      live: true,
      sum: async (src) => { const pk = await src.ftPeek(); const n = ((pk && pk.log) || []).filter((l) => /overdue|re-armed|stalled/.test(l.msg || '')).length; return [n ? 'warn' : 'ok', n ? `${n} recoveries in the object's log` : 'no stalls']; },
      body: async (src) => {
        const pk = await src.ftPeek();
        const active = await src.r2head(FT_ACTIVE_KEY);
        const rec = ((pk && pk.log) || []).filter((l) => /overdue|re-armed|stalled|watchdog/.test(l.msg || ''));
        return [B.kv([['Recoveries in the log', C.n(rec.length)], ['Latest', rec[0] ? C.time(rec[0].at, rec[0].msg) : '—'], ['Next alarm', pk && pk.alarm ? C.time(pk.alarm) : C.txt('none set')],
          ['Active marker', active ? C.txt('present', 'the cron checks the build each minute') : C.txt('absent')]]),
          B.note('If a build\'s alarms stop arriving, the minute cron runs its overdue slices, and the 15-minute pipeline check re-arms a build that has stalled.')];
      },
    }),
    P('ft-input', 'Model input', {
      sum: async () => [null, `engine ${ENGINE_VERSION}; ESPN win chances and projections`],
      body: async (src) => {
        const lsd = await src.digest('live_scoring_digest');
        const rows = ((lsd && lsd.games) || []).map((g) => {
          const a = (g.away.winProb ?? 50) / 100, h = (g.home.winProb ?? 50) / 100, sum = a + h || 1;
          return B.row([C.mix(C.team(g.away.teamId), C.txt(' at '), C.team(g.home.teamId)), C.pct((a / sum) * (1 - TIE_CHANCE)), C.pct((h / sum) * (1 - TIE_CHANCE)), C.pct(TIE_CHANCE),
            C.txt(`${(g.away.projected || 0).toFixed(1)} / ${(g.home.projected || 0).toFixed(1)}`)]);
        });
        const sum = await src.ftSummary();
        return [B.kv([['Engine version', C.n(ENGINE_VERSION)], ['Score spread', C.txt(`${SCORE_DIFF_SD} points`, 'one matchup\'s score difference')], ['Tie chance', C.pct(TIE_CHANCE)],
          ['This week', C.txt('ESPN\'s own win probability')], ['Later weeks', C.txt('ESPN projected lineups', 'one roster fetch per week')], ['Fallback', C.txt('season average points')],
          ['Fingerprint', sum && sum.fingerprint ? C.code(String(sum.fingerprint).slice(0, 12)) : C.txt('none yet')]]),
          ...(rows.length ? [B.sub('This week\'s games as the model would read them now'), B.table([['Game'], ['Away wins', 'n'], ['Home wins', 'n'], ['Tie', 'n'], ['Projected', 'n']], rows)] : []),
          B.note('A change to anything the fingerprint covers (results before the window, the window\'s fixtures, the rules, divisions, the tie rule or the engine version) rebuilds over the same weeks.')];
      },
    }),
    P('ft-odds', 'ESPN\'s odds, recorded', {
      sum: async (src) => { const o = await src.ftOdds(); const n = o && o.weeks ? Object.keys(o.weeks).length : 0; return [null, n ? `${n} week${n === 1 ? '' : 's'} recorded` : 'none recorded yet']; },
      body: async (src) => {
        const o = await src.ftOdds();
        if (!o || !o.weeks || !Object.keys(o.weeks).length) return [B.empty('ESPN\'s weekly odds are recorded by the pipeline check; none yet.')];
        const weeks = Object.keys(o.weeks).map(Number).sort((a, b) => a - b);
        const teams = [...new Set(weeks.flatMap((w) => Object.keys(o.weeks[w])))];
        return [B.table([['Team']].concat(weeks.map((w) => [`After week ${w}`, 'n'])), teams.map((t) => B.row([C.team(t)].concat(weeks.map((w) => (o.weeks[w][t] != null ? C.pct(o.weeks[w][t]) : '—')))))),
          B.kv([['Updated', C.time(o.updatedAt)], ['Season', C.txt(String(o.season))]]),
          B.note('ESPN can say only what its odds are now, never what they were, so the pipeline keeps one entry per settled week for the odds-by-week chart.')];
      },
    }),
    P('ft-feas', 'How big a build would be now', {
      sum: async (src, ctx) => [null, ctx.ftp && ctx.ftp.opensAfterWeek ? `opens after week ${ctx.ftp.opensAfterWeek}` : 'see the table'],
      body: async (src) => {
        const s = await src.settings(); const sched = await src.digest('season_schedule');
        if (!s || !sched) return [B.empty('The league\'s schedule has not been stored yet.')];
        let st; try { st = leagueState(sched, s.raw); } catch { st = null; }
        if (!st) return [B.empty('The league\'s schedule could not be read.')];
        const rows = [];
        for (let w = 1; w <= Math.min(st.weeksLeft, 6); w++) {
          const f = feasibility({ teams: st.teamCount, weeksLeft: w, kind: st.kind });
          rows.push(B.row([C.txt(w === st.weeksLeft ? `${w} (now)` : String(w)), C.txt(fmtPaths(f.paths)), C.txt(fmtHours(f.hours)), f.ok ? C.pill('ok', 'yes') : C.pill('idle', 'not yet', f.why)]));
        }
        if (st.weeksLeft > 6) rows.push(B.row([C.txt(`${st.weeksLeft} (now)`), C.txt('far beyond'), '—', C.pill('idle', 'not yet')]));
        return [B.table([['Weeks left'], ['Paths', 'n'], ['Estimated build', 'n'], ['Fits']], rows),
          B.note(`${st.teamCount} teams, ${st.kind === 'fast' ? 'points-based seeding' : st.kind === 'div' ? 'divisions' : 'head-to-head seeding'}. Anything over three days at the 50% allowance, or whose merge would need more than about 100 MB, waits.`)];
      },
    }),
    P('ft-store', 'Stored', {
      sum: async (src) => { const c = await src.census(); const p = c && c.prefixes.find((x) => x.prefix === 'fortune-teller/'); return [null, p ? `${fmtB(p.bytes)} in R2` : 'census pending']; },
      body: async (src) => {
        const keys = [['fortune-teller/pipeline.json', 'the pipeline\'s last decision'], ['fortune-teller/espn-odds.json', 'ESPN\'s weekly odds'], ['fortune-teller/summary.json', 'what members see'], [FT_ACTIVE_KEY, 'a build is running']];
        const rows = [];
        for (const [k, what] of keys) { const h = await src.r2head(k); rows.push(B.row([C.code(k), C.txt(what), h ? C.bytes(h.size) : C.txt('absent'), h ? C.time(h.uploaded instanceof Date ? h.uploaded.toISOString() : h.uploaded) : '—'])); }
        const c = await src.census();
        const pk = await src.ftPeek();
        const sub = (c && c.ft) || {};
        return [B.table([['Where'], ['What'], ['Size', 'n'], ['Updated', 'n']], rows),
          B.kv([['Live maps', sub.maps ? C.txt(`${sub.maps.objects} maps`, fmtB(sub.maps.bytes)) : '—'], ['Library', sub.library ? C.txt(`${sub.library.datasets} dataset${sub.library.datasets === 1 ? '' : 's'}`, fmtB(sub.library.bytes)) : '—'],
            ['The build object', pk && pk.dbBytes ? C.bytes(pk.dbBytes, 'job, input, meter, part notes, log') : '—']])];
      },
    }),
    P('ft-log', 'The build object\'s log', {
      live: true,
      sum: async (src) => { const pk = await src.ftPeek(); const l = pk && pk.log && pk.log[0]; return [l && l.level === 'error' ? 'bad' : null, l ? `latest ${agoText(src.now - Date.parse(l.at))}: ${String(l.msg).slice(0, 60)}` : 'empty']; },
      body: async (src) => {
        const pk = await src.ftPeek();
        const log = (pk && pk.log) || [];
        return log.length ? [B.table([['When', 'n'], ['Level'], ['Entry']], log.slice(0, 40).map((l) => B.row([C.time(l.at), C.pill(l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : 'idle', l.level), C.txt(l.msg)], l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : null))),
          B.note('The object keeps its last 150 entries; the newest 40 are shown.')] : [B.empty('The build object has logged nothing yet.')];
      },
    }),
  ];
}

// ---------------------------------------------------------------- assembly for a page

/** Whether a page has panels of its own here: every tool must, a test says so. */
export function hasOwnPanels(key) {
  return Boolean(OWN[key] && OWN[key].panels && OWN[key].panels.length);
}

export function pagePanels(page) {
  const own = OWN[page.key] || { panels: [], settings: null };
  return [...own.panels, ...standard(page, own.settings)];
}

export { routeStats, openTabs };
