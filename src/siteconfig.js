/**
 * Site Configuration.
 *
 * Admin-gated with no persistent session: the Admin Password is asked for when
 * the page opens and re-sent with every individual change, and the server
 * verifies it afresh each time. The password lives only in a JavaScript
 * variable for the life of the page — never a cookie, never storage — so
 * closing the tab ends admin access completely.
 *
 * Visually this is the densest surface in the site, so it leans on the same
 * broadcast framing but swaps the roomy form rhythm for stat-line rows: label
 * left, value right, hairline between. That keeps it legible at a glance
 * without inventing a second visual language.
 */

import { shell, passwordField, selectField, displayTitle, esc, backAction, HISTORY_RUNNER_JS } from './ui.js';
import { TRADE_ROWS, TRADE_GROUPS } from './traderows.js';

export function siteConfigPage({ theme, reduceMotion, leagueName }) {
  const rail = `
    <p class="eyebrow">Restricted</p>
    ${displayTitle('Site Config')}
`;

  const body = `
    <section id="gate">
      <div class="panel">
        <span class="ghostmark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="1.6"><rect x="4" y="10.5" width="16" height="11"/>
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/><circle cx="12" cy="16" r="1.4"/></svg></span>
        ${passwordField({
          id: 'adminPw', label: 'Admin Password', autofocus: true,
          autocomplete: 'current-password',
        })}
        <button class="primary" id="unlock">Unlock</button>
        <div class="msg" id="gateMsg"></div>
      </div>
    </section>

    <section id="panel" hidden>
      <!-- The short panels flow into balanced columns on a wide window; the
           weighting list, far longer than the rest, runs full width beneath them
           with its own rows in columns. On a narrow screen the wrapper
           dissolves and every panel keeps its reading order. -->
      <div class="cfgflow">
        <div class="panel p-conn">
          <div class="panelhead"><span class="t">League connection</span></div>
          <div class="row"><span>League ID</span><b id="leagueId">&mdash;</b></div>
          <div class="row"><span>Season</span><b id="season">&mdash;</b></div>
          <div class="row"><span>League type</span><b id="privacy">&mdash;</b></div>
          <div class="row"><span>History seasons</span><b id="history">&mdash;</b></div>
          <p class="hint" style="margin-bottom:0">League ID is fixed after setup.</p>
        </div>

        <div class="panel p-cookies">
          <div class="panelhead"><span class="t">ESPN cookies</span></div>
          <div class="row"><span>espn_s2</span><b id="s2state">&mdash;</b></div>
          <div class="row"><span>SWID</span><b id="swidstate">&mdash;</b></div>
          <p class="hint">Replace these if league data stops loading.</p>
          <div class="field-row">
            <label for="newS2">New espn_s2</label>
            <input id="newS2" type="text" autocomplete="off" spellcheck="false"
                   placeholder="Leave blank to keep">
          </div>
          <div class="field-row">
            <label for="newSwid">New SWID</label>
            <input id="newSwid" type="text" autocomplete="off" spellcheck="false"
                   placeholder="Leave blank to keep">
          </div>
          <button class="primary" data-action="cookies">Test and save</button>
          <div class="msg" id="msgCookies"></div>
        </div>

        <div class="panel p-pw">
          <div class="panelhead"><span class="t">Passwords</span></div>
          ${passwordField({ id: 'newLeaguePw', label: 'New League Password',
            hint: 'Leave blank to keep the current one. Everyone will need the new one.' })}
          ${passwordField({ id: 'newAdminPw', label: 'New Admin Password',
            hint: 'Leave blank to keep the current one.' })}
          <button class="primary" data-action="passwords">Save passwords</button>
          <div class="msg" id="msgPasswords"></div>
        </div>

        <div class="panel p-tools">
          <div class="panelhead"><span class="t">Tools</span></div>
          <div id="toolRows"></div>
          <div class="msg" id="msgTools"></div>
        </div>

        <div class="panel p-data">
          <div class="panelhead"><span class="t">League data</span></div>
          <div class="row"><span>Status</span><b id="primeState">&mdash;</b></div>
          <div class="bar"><i id="primeBar"></i></div>
          <p class="hint">Fetches every dataset once. Run this if a page is showing
             blanks, or after replacing your ESPN cookies.</p>
          <button class="primary" id="primeRun">Refresh all league data</button>
          <div class="msg" id="msgPrime"></div>
        </div>

        <div class="panel p-hist">
          <div class="panelhead"><span class="t">League history</span></div>
          <div class="row"><span>Status</span><b id="histState">&mdash;</b></div>
          <div class="bar"><i id="histBar"></i></div>
          <p class="hint" id="histDetail">Only re-pull when you need to. This may take a
         few minutes: please do not close or refresh this tab.</p>
          <button class="primary" id="histRun">Re-pull league history</button>
          <button class="ghost" id="histResume" style="margin-top:11px" hidden>Resume an interrupted pull</button>
          <div class="msg" id="msgHistory"></div>
        </div>

        <div class="panel p-ft">
          <div class="panelhead"><span class="t">Fortune Teller</span></div>
          <div class="row"><span>Status</span><b id="ftState">&mdash;</b></div>
          <div class="row"><span>Season</span><b id="ftSeason">&mdash;</b></div>
          <div class="row"><span>Build</span><b id="ftSize">&mdash;</b></div>
          <div class="bar"><i id="ftBar"></i></div>
          <p class="hint" id="ftDetail">Maps every way the rest of the regular season can go. Once switched on it
            builds by itself as soon as a build fits, runs in the background within the daily allowance, and moves on
            each week as results come in.</p>
          <button class="primary" id="ftToggle">Switch on</button>
          <button class="ghost" id="ftCheck" style="margin-top:11px">Check now</button>
          <button class="ghost" id="ftRebuild" style="margin-top:11px" hidden>Rebuild the map</button>
          <div class="msg" id="msgFt"></div>
        </div>
      </div>

      <div class="panel p-weights">
        <div class="panelhead"><span class="t">Trade Analyzer weighting</span></div>
        <p class="hint">What each statistic is worth when Trade Analyzer judges a
           deal. These become your league&rsquo;s defaults; anyone can still move the
           adjustable ones for themselves while they are looking at a trade, and
           their changes never touch these. Leave a row alone and it follows the
           shipped default, including if that default changes later.</p>
        <div id="weightRows"></div>
        <div class="wactions">
          <button class="primary" id="weightSave">Save weighting</button>
          <button class="ghost" id="weightReset">Reset all to defaults</button>
        </div>
        <div class="msg" id="msgWeights"></div>
      </div>

    </section>`;

  const css = `
    /* The gate is a single question on an otherwise empty page, so it is
       centred rather than left-aligned under a rail that has nothing in it.
       The header centres with it — a restricted-page title hanging off to one
       side of a centred prompt reads as two unrelated things. */
    .pagegrid.stack .rail { max-width:none; }
    .pagegrid.stack .railtext, .pagegrid.stack .titlebar { text-align:center; }
    .pagegrid.stack .railmark { margin:0 auto; }
    .pagegrid.stack .railtext .display { margin:0 auto; }
    .pagegrid.stack .railtext .eyebrow { justify-content:center; }
    body:has(#gate:not([hidden])) .main { display:flex; justify-content:center; }
    body:has(#gate:not([hidden])) #gate { width:min(100%,420px); }
    #gate .panel { text-align:center; }
    #gate .panel .fieldwrap, #gate .panel .msg { text-align:left; }

    /* Panels flow into columns once there is room for them, so a wide window
       reads as a control surface rather than one tall ribbon. Each panel keeps
       its own internal rhythm; only the arrangement changes. */
    /* Scoped so the grid never contradicts the hidden attribute. */
    #panel:not([hidden]) { display:grid; grid-template-columns:minmax(0,1fr); gap:0; align-items:start; }
    #panel .panel { min-width:0; }
    /* One column: the wrapper dissolves and the panels keep their reading order. */
    .cfgflow { display:contents; }
    .p-conn { order:1; } .p-cookies { order:2; } .p-pw { order:3; } .p-tools { order:4; }
    .p-weights { order:5; } .p-data { order:6; } .p-hist { order:7; }
    .wactions { display:flex; flex-direction:column; gap:11px; }
    @media (min-width:900px) {
      /* Balanced columns rather than a grid: panels of different heights stack
         independently, so none leaves a gap beside a taller neighbour. */
      .cfgflow { display:block; columns:2; column-gap:clamp(18px,2.2vw,32px); order:1; }
      .cfgflow .panel { break-inside:avoid; -webkit-column-break-inside:avoid; }
      /* A column break truncates the trailing margin of the tallest column's
         last panel, so the weighting panel below carried its own spacing or sat
         flush against whichever column ran longest. */
      .p-weights { order:2; margin-top:14px; }
      .wactions { flex-direction:row; flex-wrap:wrap; }
      .wactions button { width:auto; flex:0 1 260px; margin:0; }
    }
    @media (min-width:1100px) {
      #weightRows { columns:2; column-gap:40px; }
      #weightRows .wrow { break-inside:avoid; -webkit-column-break-inside:avoid; }
      #weightRows .wgroup { break-after:avoid; -webkit-column-break-after:avoid; }
      #weightRows > :first-child { margin-top:0; }
    }
    @media (min-width:1320px) {
      .cfgflow { columns:3; }
    }
    #gate { max-width:520px; }

    .row { display:flex; justify-content:space-between; gap:14px; padding:9px 0;
           border-bottom:1px solid var(--line); font-size:13.5px; }
    .row:last-of-type { border-bottom:0; }
    .row span { color:var(--ink-2); font-size:11px; font-weight:800;
                text-transform:uppercase; letter-spacing:.13em; padding-top:2px; }
    .row b { text-align:right; word-break:break-word; font-weight:700;
             font-variant-numeric:tabular-nums; }

    .toolrow { display:flex; align-items:center; gap:12px; padding:12px 0;
               border-bottom:1px solid var(--line); }
    .toolrow:last-child { border-bottom:0; }
    .toolrow .tname { flex:1; min-width:0; font-size:11px; font-weight:900;
      letter-spacing:.14em; text-transform:uppercase;
      background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
      -webkit-background-clip:text; background-clip:text;
      color:transparent; -webkit-text-fill-color:transparent; }
    .toolsel { flex:none; width:164px; }
    .toolsel .xselbtn { padding:9px 11px; }

    /* Trade Analyzer weighting. A row per statistic, grouped the way the tool
       groups them, so an administrator reads the same structure they will see
       in the breakdown. */
    .wgroup { margin:16px 0 6px; font-size:9px; font-weight:900; letter-spacing:.17em;
      text-transform:uppercase; color:var(--ink-3); display:flex; align-items:center;
      gap:8px; }
    .wgroup::before { content:""; width:5px; height:5px; background:var(--accent-deep);
      transform:rotate(45deg); flex:none; }
    .wrow { display:flex; align-items:center; gap:12px; padding:7px 0;
      border-bottom:1px solid var(--line); }
    .wrow:last-child { border-bottom:0; }
    .wname { flex:1 1 auto; min-width:0; font-size:12px; font-weight:800; }
    .wname em { font-style:normal; display:block; margin-top:2px; font-size:9px;
      font-weight:900; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); }
    .wrow .wslide { flex:0 1 190px; min-width:120px; -webkit-appearance:none;
      appearance:none; height:16px; background:transparent; cursor:pointer; margin:0; }
    .wrow .wslide::-webkit-slider-runnable-track { height:3px; background:var(--line-2); }
    .wrow .wslide::-moz-range-track { height:3px; background:var(--line-2); }
    .wrow .wslide::-webkit-slider-thumb { -webkit-appearance:none; appearance:none;
      width:10px; height:14px; margin-top:-5.5px; background:var(--accent); border:0;
      box-shadow:0 0 0 1px var(--field); cursor:grab; }
    .wrow .wslide::-moz-range-thumb { width:10px; height:14px; border-radius:0;
      background:var(--accent); border:0; box-shadow:0 0 0 1px var(--field); }
    .wval { flex:none; width:44px; text-align:right; font-size:12px; font-weight:900;
      font-variant-numeric:tabular-nums; color:var(--accent); }
    .wdef { flex:none; width:82px; text-align:right; font-size:9px; font-weight:800;
      letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); }
    /* Says plainly which rows this league has an opinion about. */
    .wdef.moved { color:var(--signal); }
    @media (max-width:640px) {
      .wrow { flex-wrap:wrap; gap:8px 10px; }
      .wname { flex:1 1 100%; }
      .wrow .wslide { flex:1 1 auto; }
      .wdef { width:auto; }
    }

  `;

  /* Only what the panel draws. The help text is left behind deliberately: it
     is long, it is the tool's to explain, and it would be the one part of this
     payload that could carry a character the template literal cares about. */
  const weightSpec = TRADE_ROWS.map((r) => ({ id: r.id, g: r.g, n: r.n, s: r.s ? 1 : 0, w: r.w }));

  const js = HISTORY_RUNNER_JS + `
var adminPw = null;
var WEIGHT_ROWS = ${JSON.stringify(weightSpec)};
var WEIGHT_GROUPS = ${JSON.stringify(TRADE_GROUPS)};
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

document.getElementById('unlock').addEventListener('click', unlock);
document.getElementById('adminPw').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') unlock();
});

async function unlock() {
  var el = document.getElementById('adminPw');
  var gm = document.getElementById('gateMsg');
  if (!el.value) { gm.textContent = 'Enter the Admin Password.'; gm.className = 'msg err'; return; }
  gm.className = 'msg';
  var r = await call('/api/admin/config', {}, el.value);
  if (!r.ok) {
    gm.textContent = r.error || 'That password was not correct.';
    gm.className = 'msg err'; el.select(); return;
  }
  adminPw = el.value;
  el.value = '';
  document.getElementById('gate').hidden = true;
  document.getElementById('panel').hidden = false;
  render(r);
}

function render(r) {
  var c = r.config || {};
  set('leagueId', c.leagueId || '\\u2014');
  set('season', c.season || '\\u2014');
  set('privacy', c.leaguePrivate ? 'Private' : 'Public');
  set('history', (c.historySeasons || []).join(', ') || 'not discovered yet');
  set('s2state', c.espnS2Present ? 'Set (' + c.espnS2Length + ' chars)' : 'Not set');
  set('swidstate', c.swidPresent ? (c.swidWellFormed ? 'Set' : 'Set, malformed') : 'Not set');
  renderTools(r.tools || []);
  renderWeights((r.config || {}).tradeWeights || {});
  renderHistory(r.history || {});
  renderPrime(r.prime || {});
}

/* The league data panel has to report its state on open, not just while it is
   running. Without this it showed an em dash on every visit, including
   immediately after a successful pull. */
function renderPrime(p) {
  var pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  document.getElementById('primeBar').style.width = pct + '%';
  if (p.complete) {
    var failed = p.failureCount || 0;
    set('primeState', failed ? ('Loaded, ' + failed + ' unavailable') : 'Loaded');
  } else if (p.running) {
    set('primeState', 'Partly loaded (' + p.done + ' of ' + p.total + ')');
  } else {
    set('primeState', 'Not loaded');
  }
}
function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

var VIS = [['visible', 'Visible'], ['admin', 'Admin only'], ['hidden', 'Not visible']];

function renderTools(tools) {
  var host = document.getElementById('toolRows');
  host.innerHTML = tools.map(function (t) {
    var current = VIS.filter(function (v) { return v[0] === t.visibility; })[0] || VIS[0];
    return '<div class="toolrow"><span class="tname">' + t.name + '</span>'
      + '<div class="toolsel"><div class="xsel" data-toolkey="' + t.key + '" data-value="'
      + t.visibility + '">'
      + '<button type="button" class="xselbtn" aria-haspopup="listbox" aria-expanded="false">'
      + '<span class="xselval">' + current[1] + '</span><span class="xselchev"></span></button>'
      + '<ul class="xsellist" role="listbox">'
      + VIS.map(function (v) {
          return '<li role="option" data-v="' + v[0] + '"'
            + (v[0] === t.visibility ? ' class="on"' : '') + '>' + v[1] + '</li>';
        }).join('')
      + '</ul></div></div></div>';
  }).join('');

  host.querySelectorAll('[data-toolkey]').forEach(function (sel) {
    sel.addEventListener('xselect', async function (e) {
      var r = await call('/api/admin/tool-visibility',
        { tool: sel.dataset.toolkey, visibility: e.detail.value });
      note('msgTools', r.ok ? 'Saved.' : (r.error || 'Could not save.'), r.ok ? 'ok' : 'err');
      if (r.ok && r.tools) renderTools(r.tools);
    });
  });
}

/* One row per statistic, grouped the way the tool groups them.
   All twenty-eight, not only the eleven a member can move: the other
   seventeen are fixed at whatever these say, so an administrator who cannot
   reach them cannot actually set the league's weighting. */
function renderWeights(saved) {
  var host = document.getElementById('weightRows');
  if (!host) return;
  var lastGroup = null;
  host.innerHTML = WEIGHT_ROWS.map(function (row) {
    var value = saved[row.id] === undefined ? row.w : saved[row.id];
    var head = '';
    if (row.g !== lastGroup) {
      lastGroup = row.g;
      head = '<div class="wgroup">' + esc(WEIGHT_GROUPS[row.g] || row.g) + '</div>';
    }
    return head +
      '<div class="wrow" data-row="' + row.id + '">' +
        '<span class="wname">' + esc(row.n) +
          (row.s ? '' : '<em>fixed for members</em>') + '</span>' +
        '<input class="wslide" type="range" min="0" max="200" step="5"' +
          ' value="' + Math.round(value * 100) + '"' +
          ' aria-label="Weight for ' + esc(row.n) + '">' +
        '<b class="wval">' + Math.round(value * 100) + '%</b>' +
        '<span class="wdef' + (Math.abs(value - row.w) > 1e-9 ? ' moved' : '') + '">' +
          'default ' + Math.round(row.w * 100) + '%</span>' +
      '</div>';
  }).join('');

  host.querySelectorAll('.wrow').forEach(function (rowEl) {
    var id = rowEl.dataset.row;
    var def = WEIGHT_ROWS.find(function (x) { return x.id === id; });
    var slider = rowEl.querySelector('.wslide');
    var out = rowEl.querySelector('.wval');
    var tag = rowEl.querySelector('.wdef');
    slider.addEventListener('input', function () {
      out.textContent = slider.value + '%';
      var differs = Math.abs(Number(slider.value) / 100 - def.w) > 1e-9;
      tag.classList.toggle('moved', differs);
    });
  });
}

function collectWeights() {
  var out = {};
  document.querySelectorAll('#weightRows .wrow').forEach(function (rowEl) {
    out[rowEl.dataset.row] = Number(rowEl.querySelector('.wslide').value) / 100;
  });
  return out;
}

function renderHistory(h) {
  set('histState', h.complete ? 'Loaded' : (h.running ? 'Partly loaded' : 'Not loaded'));
  // Only offer to resume when there is genuinely something part-finished.
  document.getElementById('histResume').hidden = !(h.running && !h.complete);
  var pct = h.total ? Math.round((h.done / h.total) * 100) : 0;
  document.getElementById('histBar').style.width = pct + '%';
  if (h.total) {
    document.getElementById('histDetail').textContent = h.done + ' of ' + h.total + ' steps'
      + (h.failureCount ? ' \\u00b7 ' + h.failureCount + ' failures' : '');
  }
}

document.querySelectorAll('[data-action]').forEach(function (btn) {
  btn.addEventListener('click', function () { act(btn.dataset.action, btn); });
});

async function act(action, btn) {
  btn.disabled = true;
  var label = btn.textContent; btn.textContent = 'Working';
  try {
    if (action === 'cookies') {
      var body = {
        espnS2: document.getElementById('newS2').value.trim(),
        swid: document.getElementById('newSwid').value.trim()
      };
      if (!body.espnS2 && !body.swid) { note('msgCookies', 'Enter at least one value.', 'err'); return; }
      var r = await call('/api/admin/cookies', body);
      note('msgCookies', r.ok ? 'Saved and verified against ESPN.' : (r.error || 'Could not save.'),
        r.ok ? 'ok' : 'err');
      if (r.ok) {
        document.getElementById('newS2').value = '';
        document.getElementById('newSwid').value = '';
        render(r);
      }
    }
    if (action === 'passwords') {
      var lp = document.getElementById('newLeaguePw').value;
      var ap = document.getElementById('newAdminPw').value;
      if (!lp && !ap) { note('msgPasswords', 'Enter at least one new password.', 'err'); return; }
      var r2 = await call('/api/admin/passwords', { leaguePassword: lp, adminPassword: ap });
      note('msgPasswords', r2.ok ? 'Saved.' : (r2.error || 'Could not save.'), r2.ok ? 'ok' : 'err');
      if (r2.ok) {
        if (ap) adminPw = ap;
        document.getElementById('newLeaguePw').value = '';
        document.getElementById('newAdminPw').value = '';
      }
    }
  } finally { btn.disabled = false; btn.textContent = label; }
}

document.getElementById('histRun').addEventListener('click', function () { pull(true); });
document.getElementById('histResume').addEventListener('click', function () { pull(false); });

async function primePull() {
  var btn = document.getElementById('primeRun');
  btn.disabled = true;
  note('msgPrime', 'Running', 'info');
  var bar = document.getElementById('primeBar');

  var out = await runHistoryPull({
    restart: true,
    call: function (body) { return call('/api/admin/prime-batch', body); },
    onProgress: function (r) {
      renderPrime(r);
      note('msgPrime', 'Running', 'info');
    },
    onNote: function (t) { note('msgPrime', t, 'info'); }
  });

  btn.disabled = false;
  if (out.ok) {
    var f = (out.status && out.status.failureCount) || 0;
    if (out.status) renderPrime(out.status);
    note('msgPrime', f
      ? ('Loaded, with ' + f + ' dataset' + (f === 1 ? '' : 's') + ' unavailable.')
      : 'All league data loaded.', f ? 'info' : 'ok');
  } else {
    note('msgPrime', out.error || 'Stopped.', 'err');
  }
}

document.getElementById('primeRun').addEventListener('click', primePull);

async function pull(restart) {
  var run = document.getElementById('histRun');
  var resume = document.getElementById('histResume');
  run.disabled = true; resume.disabled = true;
  note('msgHistory', 'Running', 'info');

  var out = await runHistoryPull({
    restart: restart,
    call: function (body) { return call('/api/admin/history-batch', body); },
    onProgress: function (r) { renderHistory(r); note('msgHistory', 'Running', 'info'); },
    onNote: function (t) { note('msgHistory', t, 'info'); }
  });

  run.disabled = false; resume.disabled = false;
  note('msgHistory', out.ok ? 'League history loaded.' : (out.error || 'Stopped.'),
    out.ok ? 'ok' : 'err');
}

function note(id, text, kind) {
  var el = document.getElementById(id);
  el.textContent = text; el.className = 'msg ' + (kind || 'err');
}

document.getElementById('weightSave').addEventListener('click', async function () {
  var r = await call('/api/admin/trade-weights', { weights: collectWeights() });
  note('msgWeights', r.ok ? 'Saved. Trade Analyzer will use this weighting.'
    : (r.error || 'Could not save.'), r.ok ? 'ok' : 'err');
  if (r.ok) renderWeights(r.tradeWeights || {});
});

document.getElementById('weightReset').addEventListener('click', async function () {
  // Saving nothing is what "use the defaults" means, so this is the same call
  // with every row at its shipped value rather than a separate path.
  var r = await call('/api/admin/trade-weights', { weights: {} });
  note('msgWeights', r.ok ? 'Reset to the shipped defaults.'
    : (r.error || 'Could not save.'), r.ok ? 'ok' : 'err');
  if (r.ok) renderWeights(r.tradeWeights || {});
});

/* Fortune Teller: where the pipeline stands, and the switch. */
var ftEnabled = false, ftTimer = null;
function ftRender(p) {
  var words = { early: 'Waiting for the season', available: 'Ready to build', building: 'Building', updating: 'Updating',
    ready: 'Live', 'season-over': 'Regular season over', failed: 'Failed', 'no-data': 'League data not pulled yet' };
  var st = p && p.state, b = p && p.build;
  document.getElementById('ftState').textContent = st ? (words[st] || st) : 'Not checked yet';
  document.getElementById('ftSeason').textContent = p && p.mpc ? ('Week ' + p.lastSettled + ' of ' + p.mpc + ' played' + (p.weeksLeft ? ', ' + p.weeksLeft + ' left' : '')) : '\u2014';
  document.getElementById('ftSize').textContent = st === 'early' && p.opensAfterWeek ? ('Opens after week ' + p.opensAfterWeek)
    : p && p.estimate ? (Number(p.estimate.paths).toLocaleString('en-US') + ' paths, about ' + (p.estimate.hours < 0.1 ? 'a few minutes' : p.estimate.hours < 24 ? p.estimate.hours.toFixed(1) + ' hours' : (p.estimate.hours / 24).toFixed(1) + ' days')) : '\u2014';
  var share = b && b.n ? Math.min(1, ((b.team || 0) + (b.parts > 1 && b.next !== 'merge' ? (b.part || 0) / b.parts : 0)) / b.n) : (st === 'ready' ? 1 : 0);
  document.getElementById('ftBar').style.width = Math.round(share * 100) + '%';
  document.getElementById('ftDetail').textContent = st === 'failed' ? ('The last attempt stopped: ' + (p.error || 'no reason recorded') + '. Rebuild to try again.')
    : st === 'building' || st === 'updating' ? ('Team ' + Math.min((b && b.team || 0) + 1, b && b.n || 0) + ' of ' + (b && b.n || '?') + '. It carries on without this page open.')
    : st === 'ready' ? ('The league is seeing the map through week ' + p.thru + '. It moves on by itself as each week settles.')
    : st === 'early' ? ('A build fits once week ' + p.opensAfterWeek + ' has been played. Switch it on now and it will start by itself then.')
    : st === 'available' ? 'A build fits now. Switch it on and it starts straight away.'
    : 'Maps every way the rest of the regular season can go.';
  ftEnabled = !!(p && p.enabled);
  document.getElementById('ftToggle').textContent = ftEnabled ? 'Switch off' : 'Switch on';
  document.getElementById('ftRebuild').hidden = !ftEnabled || st === 'building' || st === 'updating';
  clearTimeout(ftTimer); if (st === 'building' || st === 'updating') ftTimer = setTimeout(ftLoad, 20000);
}
async function ftLoad() {
  try { var d = await (await fetch('/api/fortune-teller', { credentials: 'same-origin' })).json(); ftRender(d.pipeline || null); } catch (e) { /* shown as not checked */ }
}
async function ftAct(action, id) {
  var btn = document.getElementById(id); btn.disabled = true;
  var r = await call('/api/admin/fortune-teller', { action: action });
  btn.disabled = false;
  note('msgFt', r.ok ? ({ enable: 'Switched on.', disable: 'Switched off.', check: 'Checked.', rebuild: 'Rebuilding.' }[action]) : (r.error || 'Could not change it.'), r.ok ? 'ok' : 'err');
  if (r.ok && r.pipeline) ftRender(Object.assign({}, r.pipeline, { enabled: r.enabled }));
}
document.getElementById('ftToggle').addEventListener('click', function () { ftAct(ftEnabled ? 'disable' : 'enable', 'ftToggle'); });
document.getElementById('ftCheck').addEventListener('click', function () { ftAct('check', 'ftCheck'); });
document.getElementById('ftRebuild').addEventListener('click', function () { ftAct('rebuild', 'ftRebuild'); });
ftLoad();

async function call(url, body, pwOverride) {
  try {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 'x-admin-password': pwOverride || adminPw || '' },
      body: JSON.stringify(body || {})
    });
    var d = await res.json().catch(function () { return {}; });
    if (!d.ok && !d.error) d.error = 'Request failed (' + res.status + ').';
    d.status = res.status;
    return d;
  } catch (e) { return { ok: false, status: 0, error: 'Could not reach the server.' }; }
}`;

  return shell({
    action: backAction(), title: 'Site Configuration', theme, reduceMotion, rail, body,
    settings: true, stack: true, centred: true, extraCss: css, extraJs: js,
    instructions: [
      ['01', 'The Admin Password is asked for every time',
       'It is needed for each change rather than held onto, so leaving this page open gives nobody else the run of it.'],
      ['02', 'Keeping the league connected',
       'League connection shows what the site is pointed at. If pages start coming up empty, replace your ESPN cookies here and save \u2014 that is almost always the cause.'],
      ['03', 'Tools have three settings',
       'Visible to the league, admin-only, or hidden. Admin-only tools still appear on the home page with a lock, so the league can see they exist.'],
      ['04', 'Trade Analyzer weighting',
       'Sets what each statistic is worth when the tool judges a deal for your league. Anyone can still move the adjustable ones while they look at a trade; that never changes what you save here.'],
      ['05', 'Fortune Teller',
       'Switch it on and it builds the map by itself as soon as the league is close enough to the end of the regular season, then moves on each week. Check now asks it to look straight away; Rebuild starts the map again from scratch.'],
      ['05', 'Re-run a pull any time',
       'Refreshing league data, and re-pulling past seasons, can both be run again whenever you like. Neither loses anything by being repeated.'],
      ['06', 'Time zone is per person',
       'The zone under the gear is yours alone, not a league setting. Everyone picks their own.'],
    ] });
}
