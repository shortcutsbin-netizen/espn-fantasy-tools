/**
 * Everything the dashboard does once it reaches the browser.
 *
 * Emitted inside a template literal: a backtick in a comment here breaks the
 * page, and a backslash escape is consumed before the browser sees it. The
 * values the server injects arrive as arguments rather than as free variables,
 * so what crosses that boundary is visible in one place.
 */
import { TEAM_COOKIE, LOGO_FALLBACK_SVG } from '../ui.js';
import { idleAwarePoller } from './poller.js';

export function dashboardClientJs({ version = '', initial = null, board = null } = {}) {
  return `
var team = document.getElementById('team');
function teamValue() { return team.dataset.value || ''; }
team.addEventListener('xselect', function (e) {
  document.cookie = '${TEAM_COOKIE}=' + encodeURIComponent(e.detail.value) +
    '; path=/; max-age=31536000; samesite=lax';
  loadBoard();
});
document.getElementById('out').addEventListener('click', async function () {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/';
});

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function logo(url, alt, cls) {
  /* A team with no logo, or one whose image will not load, gets the shield —
     never a blank gap and never invented initials. The failure path is
     onerror="this.hidden=true" and a CSS sibling rule rather than a handler
     that rewrites markup: this function is emitted inside a template literal,
     where a quoted string in an inline handler needs escaping that does not
     survive the trip to the browser. */
  var c = cls || 'tklogo';
  var shield = '${LOGO_FALLBACK_SVG}';
  if (!url) return '<span class="' + c + ' lgo lgofail">' + shield + '</span>';
  return '<span class="' + c + ' lgo"><img src="' + esc(url) + '" alt="' + esc(alt) +
    '" referrerpolicy="no-referrer" loading="lazy" onerror="this.hidden=true">' +
    shield + '</span>';
}

/* ---------------------------------------------------------------- tickers */
/* A strip is built once and then patched in place. Rebuilding it to show a new
   score would restart the animation and jump the sequence, so only the values
   inside the already-scrolling copies are updated. */
var stripSig = {};

/* Each fixture reserves only the room its own state needs.
 *
 * One width for the whole strip meant every item reserved what the longest one
 * needed — an upcoming kickoff time runs to about eighteen characters — so a
 * game reading FINAL carried a dozen blank characters after it. The reservation
 * exists to stop a label resizing mid-scroll, and a game only changes state a
 * couple of times a day, at which point the strip rebuilds once anyway.
 *
 * A little headroom on top, because a running clock grows by a character when
 * the quarter ticks over and that should not nudge the loop. */
function stateCell(state) {
  var n = Math.max(4, String(state || '').length + 1);
  return '<span class="tkstate j-s" style="--sw:' + n + 'ch"></span>';
}

function nflItem(g, i) {
  // The score cell is only rendered once a game is under way. Reserving it
  // beforehand left a visible hole in every fixture. Started state is part of
  // the structure, so a game kicking off rebuilds the strip exactly once.
  var pts = g.started ? '<b class="tkpts j-a"></b>' : '';
  var ptsH = g.started ? '<b class="tkpts j-h"></b>' : '';
  var away = '<span class="tkside">' + logo(g.awayLogo, g.away) +
    '<b class="tkab">' + esc(g.away) + '</b>' + pts + '</span>';
  var home = '<span class="tkside">' + logo(g.homeLogo, g.home) +
    '<b class="tkab">' + esc(g.home) + '</b>' + ptsH + '</span>';
  /* ESPN's own status string is Eastern time whoever is reading it, so before
     kickoff the label is rebuilt from the ISO instant in the reader's chosen
     zone. Once a game is under way the string is a clock or a quarter rather
     than a time of day, and is shown as ESPN wrote it. */
  var state = g.state || '';
  if (!g.started && g.kickoff && typeof window.fmtDateTime === 'function') {
    state = window.fmtDateTime(g.kickoff) || state;
  }
  return { key: 'n' + i,
    html: '<div class="tk" data-k="n' + i + '">' + away +
      '<span class="tkvs">AT</span>' + home + stateCell(state) + '</div>',
    vals: { a: g.started ? g.awayScore : '', h: g.started ? g.homeScore : '',
            s: state, live: !!g.inProgress, win: null } };
}

function fantasyItem(m, i) {
  function side(s, cls) {
    return '<span class="tkside ' + cls + '">' + logo(s.logo, s.name) +
      '<b class="tkab">' + esc(s.name) + '</b>' +
      ((m.started || m.state === 'final' || m.state === 'live')
        ? '<b class="tkpts j-' + cls + '"></b>' : '') + '</span>';
  }
  /* Same reading as the card and as Live Matchups: a fixture is over when its
     games are over, whether or not ESPN has written a winner yet. */
  var fin = m.state === 'final' || !!m.winner;
  var running = !fin && (m.state === 'live' || m.started);
  var played = fin || running;
  var state = fin ? 'Final' : (running ? 'Live' : 'Week ' + m.period);
  return { key: 'f' + i,
    html: '<div class="tk" data-k="f' + i + '">' + side(m.away, 'a') +
      '<span class="tkvs">VS</span>' + side(m.home, 'h') + stateCell(state) + '</div>',
    vals: { a: played ? m.away.points.toFixed(1) : '',
            h: played ? m.home.points.toFixed(1) : '',
            s: state, live: running, win: fin } };
}

function patch(runEl, items) {
  items.forEach(function (it) {
    var nodes = runEl.querySelectorAll('[data-k="' + it.key + '"]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var a = n.querySelector('.j-a'), h = n.querySelector('.j-h'), st = n.querySelector('.j-s');
      if (a && a.textContent !== it.vals.a) a.textContent = it.vals.a;
      if (h && h.textContent !== it.vals.h) h.textContent = it.vals.h;
      if (st && st.textContent !== it.vals.s) st.textContent = it.vals.s;
      n.classList.toggle('live', !!it.vals.live);
    }
  });
}

function marquee(runEl, stripEl, emptyEl, items) {
  var id = runEl.id;
  if (!items.length) {
    stripEl.hidden = true; emptyEl.hidden = false;
    runEl.innerHTML = ''; stripSig[id] = ''; return;
  }
  stripEl.hidden = false; emptyEl.hidden = true;

  // Structure only. Values are deliberately excluded so a score change patches
  // rather than rebuilds.
  var structure = items.map(function (it) { return it.html; }).join('');
  // Bucket the width so a one-pixel reflow cannot trigger a rebuild.
  /* The zone is part of the signature because a different zone can produce a
     different label length, and the reserved state width is measured at build
     time. Changing zones is a deliberate act, so one rebuild is the right cost
     for keeping the loop seamless afterwards. */
  var signature = structure + '|' + Math.round(stripEl.clientWidth / 24) +
    '|' + (typeof window.siteTz === 'function' ? window.siteTz() : '');

  if (stripSig[id] === signature) { patch(runEl, items); return; }
  stripSig[id] = signature;

  runEl.style.animation = 'none';
  runEl.innerHTML = structure;
  patch(runEl, items);
  var copyWidth = Math.max(1, runEl.scrollWidth);
  var stripWidth = stripEl.clientWidth || copyWidth;

  var copies = Math.max(3, Math.ceil((stripWidth * 2) / copyWidth) + 2);
  var out = '';
  for (var i = 0; i < copies; i++) out += structure;
  runEl.innerHTML = out;

  runEl.style.setProperty('--shift', (-copyWidth) + 'px');
  runEl.style.setProperty('--dur', Math.max(8, copyWidth / 42).toFixed(2) + 's');
  void runEl.offsetWidth;
  runEl.style.animation = '';
  patch(runEl, items);
}

/* ---------------------------------------------------------------- team card */
var KICKOFF = null, cdTimer = null;

/* The win split as one dial rather than two.
 *
 * A matchup has exactly two outcomes, so a single ring divided between them
 * says more than a lone percentage: the reader sees both shares and which way
 * it leans in one glance. The reader's own side is drawn in the accent green
 * from the top of the arc, the opponent's in blue for the remainder, and the
 * centre carries whichever side is ahead in that side's colour. */
function winGauge(m) {
  if (m.final || m.winner || typeof m.myWinProb !== 'number') return '';
  var mine = Math.max(0, Math.min(100, m.myWinProb));
  var theirs = 100 - mine;
  var R = 42, C = 2 * Math.PI * R;
  var lead = mine >= theirs;
  var pct = (lead ? mine : theirs).toFixed(0);
  return '<div class="wgauge" role="img" aria-label="' +
      mine.toFixed(0) + ' percent to win">' +
    '<svg viewBox="0 0 100 100">' +
      '<circle class="wgtrack" cx="50" cy="50" r="' + R + '"/>' +
      '<circle class="wgtheirs" cx="50" cy="50" r="' + R + '" ' +
        'stroke-dasharray="' + C + '" stroke-dashoffset="' + (C * (1 - theirs / 100)) + '" ' +
        'transform="rotate(' + (-90 + 360 * (mine / 100)) + ' 50 50)"/>' +
      '<circle class="wgmine" cx="50" cy="50" r="' + R + '" ' +
        'stroke-dasharray="' + C + '" stroke-dashoffset="' + (C * (1 - mine / 100)) + '" ' +
        'transform="rotate(-90 50 50)"/>' +
    '</svg>' +
    '<span class="wgmid ' + (lead ? 'smine' : 'stheirs') + '">' + pct + '<i>%</i></span>' +
  '</div>';
}

function two(n) { return n < 10 ? '0' + n : String(n); }

function renderCountdown() {
  var el = document.getElementById('cdown');
  if (!el || !KICKOFF) return;
  var ms = new Date(KICKOFF).getTime() - Date.now();
  if (!isFinite(ms)) return;
  if (ms <= 0) { el.innerHTML = 'Kickoff'; return; }
  var s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
  var h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  el.innerHTML = (d ? d + '<em>d</em> ' : '') + two(h) + '<em>:</em>' + two(m) +
    '<em>:</em>' + two(sec);
}

/* Team names are always shown in full.
   Substituting an abbreviation past sixteen characters meant the same team
   read as "Down for THE WIN!" in one place and "DFW" in another, which is a
   worse outcome than a long name wrapping. The card lets the name wrap
   instead. */
function short(name) {
  return name || '';
}

/* Record, rank and points for either side of the card. Shown for both teams:
   a matchup is a comparison, and giving the reader one side's season and not
   the other's just sends them off to look the missing half up. */
function seasonStats(sl, started) {
  if (!sl) return '';
  /* Before week one every record is 0-0 and every rank is just where a team
     landed in a tie-break of nothing. Showing it on one side was quietly
     misleading; showing it on both would have invited a comparison that does
     not exist yet. */
  if (started === false) return '';
  return '<div class="cardstats">' +
    (sl.record ? '<span class="stat"><b>' + esc(sl.record) + '</b><span>Record</span></span>' : '') +
    (sl.rank ? '<span class="stat"><b>' + sl.rank + '</b><span>Rank</span></span>' : '') +
    (sl.pointsFor != null ? '<span class="stat"><b>' + sl.pointsFor.toFixed(0) + '</b><span>PF</span></span>' : '') +
    '</div>';
}

function renderCard(t, identified) {
  var panel = document.getElementById('cardPanel');
  if (!t) { panel.hidden = true; KICKOFF = null; return; }
  if (identified === false) {
    panel.hidden = false;
    document.getElementById('cardBody').innerHTML =
      '<div class="placeholder"><b>Loading league data</b>' +
      '<span>Your matchup appears once team names have loaded.</span></div>';
    KICKOFF = null;
    return;
  }
  panel.hidden = false;
  var mySeason = (t.matchup && t.matchup.mySeason) || (t.record ? {
    record: t.record, rank: t.rank, pointsFor: t.pointsFor, owner: t.owner
  } : null);
  var stats = seasonStats(mySeason, t.seasonStarted);

  var mid, vs = '';
  if (t.matchup) {
    var m = t.matchup;
    /* A matchup that has kicked off shows what it is worth, not how long until
       something that already happened. The countdown is for a fixture where
       nobody has taken the field yet. */
    if (m.inPlay || m.started) {
      var done = !!(m.final || m.winner);
      /* Home or away is not on this payload and does not need to be: the two
         scores already say who won. */
      var diff = m.myPoints - m.oppPoints;
      var iWon = diff > 0, tied = Math.abs(diff) < 0.005;
      /* A projection on a finished game is a guess about something that has
         already happened, so it comes off once the result is in. */
      var projMe = (!done && m.myProjected != null)
        ? '<span class="sproj">' + m.myProjected.toFixed(1) + '</span>' : '';
      var projOpp = (!done && m.oppProjected != null)
        ? '<span class="sproj">' + m.oppProjected.toFixed(1) + '</span>' : '';
      var centre = done
        ? '<div class="vsmargin ' + (tied ? 'tied' : iWon ? 'won' : 'lost') + '">' +
            (tied ? 'Tied'
              : (iWon ? 'Won by ' : 'Lost by ') + Math.abs(diff).toFixed(1)) +
          '</div>'
        : winGauge(m);
      mid = '<div class="vsgrid' + (done ? ' isdone' : '') + '">' +
        '<div class="vslabel' + (done ? ' isfinal' : '') + '">' +
          (done ? 'Final' : 'Live') + '</div>' +
        '<div class="vsscore mine' + (done && iWon ? ' won' : '') + '">' +
          '<b class="smine">' + m.myPoints.toFixed(1) + '</b>' + projMe + '</div>' +
        centre +
        '<div class="vsscore theirs' + (done && !iWon && !tied ? ' won' : '') + '">' +
          '<b class="stheirs">' + m.oppPoints.toFixed(1) + '</b>' + projOpp + '</div>' +
      '</div>';
    } else if (t.kickoff && Date.parse(t.kickoff) > Date.now()) {
      mid = '<div class="countdown" id="cdown">--</div><div class="vslabel">Until kickoff</div>';
    } else if (t.kickoff) {
      /* A kickoff already in the past with the matchup not under way: the
         scoring period has rolled but the NFL schedule on hand is still last
         week's, so there is nothing ahead to count down to. Counting down to a
         time that has been and gone read as "Kickoff / until kickoff" and sat
         there. The week is the honest thing to say until a schedule arrives. */
      mid = '<div class="vslabel">Week ' + m.period + '</div>' +
        '<div class="cdnote">Schedule not posted yet</div>';
    } else {
      mid = '<div class="vslabel">Week ' + m.period + '</div>';
    }
    var meLabel = short(t.name);
    var oppLabel = short(t.matchup.opponent);
    var oppStats = seasonStats(t.matchup.opponentSeason, t.seasonStarted);
    vs = '<div class="vsrow">' +
      '<span class="vsme">' + logo(t.logo, t.name, 'cardlogo') +
        '<span class="vsid"><span class="vsname">' + esc(meLabel) + '</span>' +
        '<span class="vsowner">' + esc(t.owner || '') + '</span>' + stats + '</span>' +
      '</span>' +
      '<span class="vsmid">' + mid + '</span>' +
      '<span class="vsopp">' +
        '<span class="vsid"><span class="vsname">' + esc(oppLabel) + '</span>' +
        '<span class="vsowner">' + esc(t.matchup.opponentOwner || '') + '</span>' +
        oppStats + '</span>' +
        logo(t.matchup.opponentLogo, t.matchup.opponent, 'cardlogo') +
      '</span></div>';
  } else {
    vs = '<div class="placeholder"><b>No matchup scheduled</b>' +
      '<span>This week has no fixture for your team.</span></div>';
  }

  document.getElementById('cardBody').innerHTML = vs;

  KICKOFF = (t.matchup && !t.matchup.started && !t.matchup.inPlay) ? t.kickoff : null;
  if (cdTimer) clearInterval(cdTimer);
  if (KICKOFF) { renderCountdown(); cdTimer = setInterval(renderCountdown, 1000); }
}

/* ---------------------------------------------------------------- board */
/* Two weeks of waiver noise buried the useful part of this list, and the panel
   is a glance rather than an archive. The wider ranges are one click away. */
var TX = [], RANGE = 7;

/* Which way each column reads when you first click it. Ranking columns count
   down — the best is the biggest — while a name reads alphabetically. */
var ST_COLS = [
  { key: 'rank',         label: 'Seed',     dir: 1 },
  { key: 'name',         label: 'Team',     dir: 1,  cls: 'col-team' },
  { key: 'record',       label: 'Record',   dir: -1 },
  { key: 'winPct',       label: 'Win%',     dir: -1 },
  { key: 'pointsFor',    label: 'PF',       dir: -1 },
  { key: 'pointsAgainst',label: 'PA',       dir: -1 },
  { key: 'diff',         label: 'Diff',     dir: -1 },
  { key: 'ppg',          label: 'PPG',      dir: -1 },
  { key: 'streak',       label: 'Strk',     dir: -1 },
  { key: 'playoffPct',   label: 'Playoff%', dir: -1 },
  { key: 'simPct',       label: 'Sim%',     dir: -1 }
];
/* Sim % appears only once a real simulation has run; until then the column is not there at all. */
function stCols() { return stSim && stSim.byTeam ? ST_COLS : ST_COLS.filter(function (c) { return c.key !== 'simPct'; }); }
/* Fortune Teller's simulated odds, or why there are none yet; set by every status poll. */
var stSim = null;
var stSort = { key: 'rank', dir: 1 };

function stDerived(r) {
  var played = (r.wins || 0) + (r.losses || 0) + (r.ties || 0);
  return {
    played: played,
    winPct: played ? ((r.wins || 0) + (r.ties || 0) * 0.5) / played : 0,
    // This season only: points scored divided by games played.
    ppg: played ? (r.pointsFor || 0) / played : 0,
    record: (r.wins || 0) * 1000 - (r.losses || 0) + (r.ties || 0) * 0.5
  };
}

function stValue(r, key) {
  var d = stDerived(r);
  if (key === 'record') return d.record;
  if (key === 'winPct') return d.winPct;
  if (key === 'ppg') return d.ppg;
  if (key === 'diff') return (r.pointsFor || 0) - (r.pointsAgainst || 0);
  if (key === 'name') return String(r.name || '').toLowerCase();
  if (key === 'streak') {
    // A win streak sorts above a losing one, longest first within each.
    var m = /^([WL])(\d+)$/.exec(r.streak || '');
    if (!m) return -999;
    return (m[1] === 'W' ? 1 : -1) * Number(m[2]);
  }
  if (key === 'playoffPct') { var fin = stFinal(r); return fin != null ? fin : (r.playoffPct == null ? -1 : r.playoffPct); }
  if (key === 'simPct') { var sv = stSim && stSim.byTeam ? stSim.byTeam[r.teamId] : null; return sv == null ? -1 : sv; }
  return r[key] == null ? -1 : r[key];
}

function stMedal(rank) {
  if (rank === 1) return '<span class="medal g" title="First">1</span>';
  if (rank === 2) return '<span class="medal s" title="Second">2</span>';
  if (rank === 3) return '<span class="medal b" title="Third">3</span>';
  return String(rank);
}

/* After the regular season every team is in or out: its final seed decides, not ESPN's last figure. */
function stFinal(r) { var f = stSim && stSim.final; return f && f.seasonOver && f.inByTeam && f.inByTeam[r.teamId] != null ? (f.inByTeam[r.teamId] ? 1 : 0) : null; }

function stOdds(r) {
  var fin = stFinal(r);
  if (fin != null) return fin ? '<span class="stflag in">Clinched</span>' : '<span class="stflag out">Eliminated</span>';
  if (r.playoffPct == null) return '<span class="dim">&mdash;</span>';
  /* At the extremes the number has stopped being a probability. Printing
     "100%" invites a reader to wonder what the other nothing per cent is. */
  if (r.playoffPct >= 0.9995) return '<span class="stflag in">Clinched</span>';
  if (r.playoffPct <= 0.0005) return '<span class="stflag out">Eliminated</span>';
  return '<span class="stpct">' + (r.playoffPct * 100).toFixed(1) + '%</span>';
}

/* Sim %: the same markers as Playoff % at the extremes; before the simulation has run, the
   reason it has not, and while a week is being folded in, last week's figure, dimmed. */
function stSimCell(r) {
  var s = stSim, v = s && s.byTeam ? s.byTeam[r.teamId] : null;
  if (v == null) return '<span class="dim">&mdash;</span>';
  var cell = v >= 0.9995 ? '<span class="stflag in">Clinched</span>'
    : v <= 0.0005 ? '<span class="stflag out">Eliminated</span>'
    : '<span class="stpct">' + (v * 100).toFixed(1) + '%</span>';
  return s.state === 'updating' ? '<span class="stupd" title="Updating for the week just played">' + cell + '</span>' : cell;
}

/**
 * The same scroller Hall of Fame uses, in the vanilla the dashboard is written
 * in. The bar is drawn rather than borrowed from the platform, because the
 * native one is an overlay that hides itself when idle — so a table with more
 * to the right looked like a table that ended there.
 */
function wireScrollBox(host) {
  var wrap = host.querySelector('.scrollwrap');
  if (!wrap) return;
  var real = wrap.querySelector('.scrollreal');
  var bar = wrap.querySelector('.sbar');
  var thumb = wrap.querySelector('.sbar-thumb');
  if (!real || !bar || !thumb) return;
  var drag = null, frame = 0;

  function layout() {
    var cw = real.clientWidth, sw = real.scrollWidth;
    if (sw <= cw + 1) { bar.hidden = true; return; }
    bar.hidden = false;
    var barW = bar.clientWidth || cw;
    var tw = Math.max(32, Math.round(barW * (cw / sw)));
    thumb.style.width = tw + 'px';
    var max = sw - cw;
    thumb.style.transform = 'translateX(' +
      (max > 0 ? (real.scrollLeft / max) * (barW - tw) : 0) + 'px)';
  }
  /* Deferred a frame: layout() writes to the element being observed, so
     calling it straight from the observer re-enters it. */
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(function () { frame = 0; layout(); });
  }

  real.addEventListener('scroll', layout);
  window.addEventListener('resize', schedule);
  if (typeof ResizeObserver === 'function') {
    try { new ResizeObserver(schedule).observe(real); } catch (e) { /* not fatal */ }
  }

  thumb.addEventListener('pointerdown', function (e) {
    drag = { x: e.clientX, left: real.scrollLeft, tw: thumb.offsetWidth, barW: bar.clientWidth };
    bar.classList.add('dragging');
    try { thumb.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    e.preventDefault(); e.stopPropagation();
  });
  thumb.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var travel = Math.max(1, drag.barW - drag.tw);
    real.scrollLeft = drag.left +
      ((e.clientX - drag.x) / travel) * (real.scrollWidth - real.clientWidth);
    layout();
    e.preventDefault();
  });
  function release(e) {
    if (!drag) return;
    drag = null;
    bar.classList.remove('dragging');
    try { thumb.releasePointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
  }
  thumb.addEventListener('pointerup', release);
  thumb.addEventListener('pointercancel', release);
  bar.addEventListener('pointerdown', function (e) {
    if (e.target === thumb) return;
    var r = bar.getBoundingClientRect();
    var frac = (e.clientX - r.left) / Math.max(1, r.width);
    real.scrollLeft = frac * (real.scrollWidth - real.clientWidth);
    layout();
  });

  layout();
  // A web font or a late logo can change the width after first paint.
  setTimeout(layout, 120);
}

function renderStandings(st) {
  var host = document.getElementById('standings');
  if (!st || !st.rows.length) {
    host.innerHTML = '<div class="placeholder"><b>Standings unavailable</b>' +
      '<span>They appear once the league is set up.</span></div>';
    return;
  }
  /* Rows exist but carry no team identity yet. Rendering them would print
     "Team 1", "Team 2" — which reads as a league nobody named rather than as
     data still on its way. */
  if (st.identified === false) {
    host.innerHTML = '<div class="placeholder"><b>Loading league data</b>' +
      '<span>Team names and records arrive with the next refresh.</span></div>';
    return;
  }
  if (!st.started) {
    host.innerHTML = '<div class="placeholder"><b>Season has not started</b>' +
      '<span>Records and points appear after week one.</span></div>';
    return;
  }
  var mine = teamValue() ? Number(teamValue()) : null;

  var rows = st.rows.slice().sort(function (a, b) {
    var av = stValue(a, stSort.key), bv = stValue(b, stSort.key);
    if (av < bv) return -1 * stSort.dir;
    if (av > bv) return 1 * stSort.dir;
    return (a.rank || 0) - (b.rank || 0);
  });

  var cols = stCols();
  if (!cols.some(function (c) { return c.key === stSort.key; })) stSort = { key: 'rank', dir: 1 };
  var head = cols.map(function (c) {
    var on = stSort.key === c.key;
    var aria = on ? (stSort.dir === 1 ? 'ascending' : 'descending') : 'none';
    return '<th class="' + (c.cls || '') + '" aria-sort="' + aria + '" data-sort="' + c.key + '">' +
      '<span class="lbl">' + esc(c.label) + '</span>' +
      '<span class="arrow">' + (on && stSort.dir === 1 ? '\u25B2' : '\u25BC') + '</span></th>';
  }).join('');

  var body = rows.map(function (r) {
    var d = stDerived(r);
    var diff = (r.pointsFor || 0) - (r.pointsAgainst || 0);
    return '<tr class="' + (r.teamId === mine ? 'me' : '') + '">' +
      '<td class="c-rank">' + stMedal(r.rank) + '</td>' +
      '<td class="col-team"><div class="stname">' + logo(r.logo, r.name, 'tklogo') +
        '<div class="stnamewrap"><b>' + esc(r.name) + '</b>' +
        (r.owner ? '<em>' + esc(r.owner) + '</em>' : '') + '</div></div></td>' +
      '<td class="c-key">' + r.wins + '-' + r.losses + '-' + (r.ties || 0) + '</td>' +
      '<td class="c-key">' + (d.winPct * 100).toFixed(1) + '%</td>' +
      '<td class="c-num">' + r.pointsFor.toFixed(1) + '</td>' +
      '<td class="c-num">' + r.pointsAgainst.toFixed(1) + '</td>' +
      '<td class="' + (diff >= 0 ? 'c-pos' : 'c-neg') + '">' +
        (diff >= 0 ? '+' : '\u2212') + Math.abs(diff).toFixed(1) + '</td>' +
      '<td class="c-num">' + d.ppg.toFixed(1) + '</td>' +
      '<td class="' + (!r.streak ? 'c-muted' : (r.streak.charAt(0) === 'W' ? 'c-pos' : 'c-neg')) + '">' +
        esc(r.streak || '\u2014') + '</td>' +
      '<td class="c-num">' + stOdds(r) + '</td>' +
      (stSim && stSim.byTeam ? '<td class="c-num">' + stSimCell(r) + '</td>' : '') + '</tr>' +
      /* The line under the last playoff place, in standings order only: sorted any other way it would mark nothing. */
      (stSort.key === 'rank' && stSort.dir === 1 && st.places && r.rank === st.places && st.places < rows.length
        ? '<tr class="porow" aria-hidden="true"><td colspan="' + cols.length + '"><span><i></i>Playoffs</span></td></tr>' : '');
  }).join('');

  /* Sorting replaces the rows, never the scrolling element: rebuilding the
     scroller would reset the horizontal position on every click, and the reader
     would be thrown back to the left edge each time they sorted. */
  var table = host.querySelector('.scrollreal table.stbl');
  if (table) {
    table.innerHTML = '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>';
  } else {
    host.innerHTML = '<div class="scrollwrap">' +
      '<div class="sbar" hidden><div class="sbar-thumb"></div></div>' +
      '<div class="scrollreal"><table class="datatable stbl">' +
      '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
    wireScrollBox(host);
  }

  var ths = host.querySelectorAll('.datatable th');
  for (var i = 0; i < ths.length; i++) {
    ths[i].addEventListener('click', function () {
      var key = this.getAttribute('data-sort');
      var col = null;
      for (var k = 0; k < ST_COLS.length; k++) if (ST_COLS[k].key === key) col = ST_COLS[k];
      if (!col) return;
      if (stSort.key === key) stSort.dir = -stSort.dir;
      else { stSort.key = key; stSort.dir = col.dir; }
      renderStandings(st);
    });
  }
}

function renderInjuries(list, hasTeam) {
  var host = document.getElementById('injuries');
  if (!hasTeam) {
    host.innerHTML = '<div class="placeholder"><b>Pick your team</b>' +
      '<span>Injury alerts follow your roster.</span></div>';
    return;
  }
  if (!list.length) {
    host.innerHTML = '<div class="placeholder"><b>Everyone available</b>' +
      '<span>No recent injuries on your roster.</span></div>';
    return;
  }
  host.innerHTML = list.map(function (p) {
    return '<div class="inj"><span class="injtag ' + esc(p.status) + '">' +
      esc(p.status.slice(0, 4)) + '</span><span><span class="injname">' + esc(p.name) +
      '</span><span class="injmeta">' + esc(p.pos) + ' &middot; ' + esc(p.team) +
      (p.type ? ' &middot; ' + esc(p.type) : '') + '</span></span>' +
      '<span class="injslot">' + esc(p.slot || '') + '</span></div>';
  }).join('');
}

/* What each state is called on the page. ESPN's own vocabulary describes its
   pipeline; a member wants to know whether the deal is waiting on them, waiting
   on the clock, done, or dead. */
var TX_STATUS = {
  completed: 'Completed',
  on_the_table: 'On the table',
  pending_approval: 'Pending approval',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
  expired: 'Expired'
};
var TX_KIND = { trade: 'Trade', waiver: 'Waiver', swap: 'Move', add: 'Add', drop: 'Drop' };

function txPlayer(p, sign) {
  return '<span class="txp' + (sign ? ' ' + sign : '') + '">' +
    (sign === 'add' ? '<span class="txsign">+</span>'
      : sign === 'drop' ? '<span class="txsign">&minus;</span>' : '') +
    esc(p.name) + (p.pos ? '<em>' + esc(p.pos) + '</em>' : '') + '</span>';
}

function txTeam(t) {
  return '<span class="txteam">' + logo(t.logo, t.name, 'tklogo') +
    '<b>' + esc(t.name) + '</b></span>';
}

function txRow(t) {
  var when = (t.date && typeof window.fmtDate === 'function') ? window.fmtDate(t.date) : '';
  var who, body;

  if (t.kind === 'trade') {
    // Both teams, and what each of them is sending. The deal, not its parts.
    who = (t.teams || []).map(txTeam).join('<span class="txswap">&#8644;</span>');
    body = (t.sides || []).map(function (side) {
      return '<span class="txgroup">' +
        side.players.map(function (p) { return txPlayer(p, null); }).join('') + '</span>';
    }).join('<span class="txswap">&#8644;</span>');
  } else {
    who = (t.teams || []).map(txTeam).join('');
    body = '<span class="txgroup">' +
      (t.adds || []).map(function (p) { return txPlayer(p, 'add'); }).join('') +
      (t.drops || []).map(function (p) { return txPlayer(p, 'drop'); }).join('') +
      '</span>';
  }

  var tags = '<span class="txkind ' + esc(t.kind) + '">' +
    esc(TX_KIND[t.kind] || t.kind) + '</span>';
  // A status is the point of a trade row and noise on anything else: an add
  // that happened is not news about its own completion.
  if (t.kind === 'trade' && TX_STATUS[t.status]) {
    tags += '<span class="txstat ' + esc(t.status) + '">' + esc(TX_STATUS[t.status]) + '</span>';
  }
  if (t.bid) tags += '<span class="txbid">$' + esc(String(t.bid)) + '</span>';

  return '<div class="txrow">' +
    '<span class="txwho">' + who + '</span>' +
    '<span class="txbody">' + body + '</span>' +
    '<span class="txtags">' + tags + '</span>' +
    '<span class="txwhen">' + esc(when) + '</span></div>';
}

function renderTransactions() {
  var host = document.getElementById('transactions');
  var cutoff = RANGE ? Date.now() - RANGE * 86400000 : 0;
  var rows = TX.filter(function (t) {
    if (!cutoff) return true;
    if (!t.date) return false;
    return Date.parse(t.date) >= cutoff;
  });

  if (!rows.length) {
    host.innerHTML = '<div class="placeholder"><b>No activity</b>' +
      '<span>Nothing moved in this window.</span></div>';
    return;
  }
  host.innerHTML = rows.map(txRow).join('');
}

document.getElementById('ranges').addEventListener('click', function (e) {
  var b = e.target.closest('[data-range]');
  if (!b) return;
  RANGE = Number(b.dataset.range);
  this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
  renderTransactions();
});

function paintBoard(d) {
  if (!d) return;
  stSim = d.sim || null;
  renderStandings(d.standings);
  renderCard(d.myTeam, d.identified);
  renderInjuries(d.injuries || [], !!d.myTeam);
  TX = d.transactions || [];
  renderTransactions();
}

async function loadBoard() {
  try {
    var q = teamValue() ? ('?team=' + encodeURIComponent(teamValue())) : '';
    var res = await fetch('/api/dashboard/board' + q);
    if (!res.ok) throw new Error(res.status);
    paintBoard(await res.json());
  } catch (e) { /* keep whatever is on screen */ }
}

/* ---------------------------------------------------------------- status */
var INITIAL = ${JSON.stringify(initial || null)};
var BOARD = ${JSON.stringify(board || null)};
var LAST = INITIAL;

window.__relayout = function () { stripSig = {}; if (LAST) paint(LAST); };
window.addEventListener('load', window.__relayout);

// Only a genuine width change can affect the measured loop. Height changes
// constantly on mobile as browser chrome collapses during a scroll, and
// reacting to those was rebuilding the strips mid-scroll.
var lastW = window.innerWidth, rt;
window.addEventListener('resize', function () {
  if (window.innerWidth === lastW) return;
  lastW = window.innerWidth;
  clearTimeout(rt); rt = setTimeout(window.__relayout, 180);
}, { passive: true });

function paint(d) {
    LAST = d;
    var nfl = d.nfl || {};
    document.getElementById('ndot').className = 'dot' + (nfl.live ? ' live' : '');
    document.getElementById('nmeta').textContent = nfl.summary || '';
    marquee(document.getElementById('nrun'), document.getElementById('nstrip'),
      document.getElementById('nempty'), (nfl.games || []).map(nflItem));

    var fan = d.fantasy || {};
    document.getElementById('fdot').className = 'dot' + (fan.live ? ' live' : '');
    document.getElementById('fmeta').textContent = fan.summary || '';
    /* Until the team payload has joined, every side of every matchup is a bare
       id. An empty strip is honest; a strip of "Team 3 vs Team 7" is not. */
    var fanItems = fan.identified === false ? [] : (fan.games || []).map(fantasyItem);
    marquee(document.getElementById('frun'), document.getElementById('fstrip'),
      document.getElementById('fempty'), fanItems);

    if (d.headlines) {
      document.getElementById('news').innerHTML = d.headlines.length
        ? d.headlines.map(function (h, i) {
            return '<a class="newsitem" href="' + esc(h.link || '#') + '" target="_blank" rel="noopener noreferrer">'
              + '<em>' + String(i + 1).padStart(2, '0') + '</em><span class="nh">'
              + esc(h.headline) + '<span>' + esc(h.source || 'ESPN') + '</span></span></a>';
          }).join('')
        : '<div class="placeholder"><b>No headlines</b><span>The wire is quiet.</span></div>';
    }
}

/* Held so a zone change can repaint from the last payload without waiting for
   the next poll. */
var LAST_STATUS = null;

window.addEventListener('tzchange', function () {
  if (LAST_STATUS) paint(LAST_STATUS);
  renderTransactions();
});

async function loadStatus() {
  try {
    var res = await fetch('/api/dashboard/status');
    if (!res.ok) throw new Error(res.status);
    LAST_STATUS = await res.json();
    paint(LAST_STATUS);
  } catch (e) {
    document.getElementById('nmeta').textContent = 'Unavailable';
    document.getElementById('fmeta').textContent = 'Unavailable';
  }
}

if (INITIAL) { LAST_STATUS = INITIAL; paint(INITIAL); } else loadStatus();
if (BOARD) paintBoard(BOARD); else loadBoard();
setInterval(loadBoard, 90000);
${idleAwarePoller('loadStatus', 15000)}

/* The update notice, shown once per browser per version.
 *
 * There is no per-member identity on this site — one shared League Password —
 * so there is no server-side record of who has read what, and localStorage is
 * the only thing that can answer "has this browser seen this version". A
 * browser with nothing stored is treated as a first visit and told nothing:
 * it has not been updated from anything.
 *
 * Every storage access is guarded. Private browsing and locked-down profiles
 * throw on access rather than returning null, and a changelog is never worth
 * taking the dashboard down over. */
(function () {
  var VERSION = ${JSON.stringify(version || '')};
  if (!VERSION) return;
  var pop = document.getElementById('updatepop');
  if (!pop) return;

  var KEY = 'eft_seen_version';

  function remember() {
    try { window.localStorage.setItem(KEY, VERSION); } catch (e) {}
  }
  function close() {
    pop.hidden = true;
    remember();
  }
  function open() {
    pop.hidden = false;
    // The drawn bar cannot measure a hidden pane; it sizes itself on the resize.
    window.dispatchEvent(new Event('resize'));
  }

  /* Dismissal is wired before anything decides whether to open, so a dialog
     that arrives already open — which diagnostics can render — can still be
     closed. Wiring it after the checks below left those buttons inert. */
  var done = document.getElementById('updateDone');
  if (done) done.addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !pop.hidden) close();
  });
  // Clicking the page behind the notice dismisses it too, the way a small
  // overlay is expected to behave. Clicks inside the box are not dismissals.
  pop.addEventListener('click', function (e) { if (e.target === pop) close(); });

  var seen = null;
  try { seen = window.localStorage.getItem(KEY); } catch (e) { return; }

  if (seen === null || seen === undefined) { remember(); return; }
  if (seen === VERSION) return;
  open();
})();`;
}
