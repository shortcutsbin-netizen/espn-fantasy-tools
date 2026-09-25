import ScrollBox from "../shared/ScrollBox.jsx";
import ToolControls from "../shared/ToolControls.jsx";
import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { PALETTES, BASE_CSS, BACKDROP } from "../../src/ui.js";
import SettingsMenu from "../shared/SettingsMenu.jsx";
import TeamLogo from "../shared/TeamLogo.jsx";
import Instructions from "../shared/Instructions.jsx";

/**
 * Hall of Fame — the league's record book.
 *
 * Everything on this page comes from `/api/hof`, which serves the derived
 * `league_history_digest` and the uncapped `h2h_full_digest` together. Neither
 * is fetched from ESPN on a request path: the archive is immutable and the two
 * digests are rebuilt on the slow poll, so the whole page is one small read.
 *
 * Chrome is the tool's own rather than shell()'s, exactly like Draft Helper and
 * Live Matchups — same tokens, same wordmark sizing, its own composition.
 *
 * The layout deliberately uses flex-wrap rather than CSS Grid for every row of
 * panels. Grid packs items into tracks and leaves an under-filled final row
 * hanging to one side, with no grid-level way to centre only the orphans; flex
 * centres every row including the last, and an expanded card simply claims a
 * full-width basis and takes its own line.
 */

const UI_FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const THEME_COOKIE = "eft_theme";

/* One rate governs the whole expand/collapse motion. Slower than a disclosure
   because a card is also travelling and resizing, not just growing. */
const EXPAND_RATE = 1.05;      // px per ms
const MIN_MS = 460, MAX_MS = 1150;
const EASE = "cubic-bezier(.25,.9,.25,1)";

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const m = new RegExp("(?:^|; )" + name + "=([^;]*)").exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : "";
}
/**
 * Coarse pointers get no expand animation at all.
 *
 * The FLIP counter-scales a whole card subtree, and on a phone that has been
 * the difference between a smooth expansion and the page dying outright. A
 * sharp expansion that always works beats a smooth one that sometimes takes
 * the tab with it, and this page is mostly read on a phone.
 */
function coarsePointer() {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 860;
  } catch {
    return window.innerWidth < 860;
  }
}
function stillnessOn() {
  return typeof document !== "undefined" &&
    document.documentElement.classList.contains("stillness");
}

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const pct = (x) => `${(Number(x || 0) * 100).toFixed(1)}%`;
const num1 = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const signed = (n) => `${Number(n) >= 0 ? "+" : ""}${Number(n || 0).toFixed(1)}`;
const yy = (year) => `'${String(year).slice(2)}`;

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function finishLabel(finish, size) {
  if (!finish) return "—";
  if (finish.rank === 1) return "Champion";
  if (finish.rank === 2) return "Runner-up";
  return size ? `${ordinal(finish.rank)} of ${size}` : ordinal(finish.rank);
}

/* ============================================================ primitives */

/**
 * The one panel anatomy used everywhere: title pinned top, value optically
 * centred and large, team identity pinned bottom, and any footnote behind an
 * info button in the corner so it never competes with the value.
 *
 * `names` is omitted wherever the owning team is already unambiguous — inside a
 * team's own card every stat is that team's, and a series stat that describes
 * the fixture rather than one side belongs to both teams by definition. A chip
 * repeating what the surrounding card already says is noise.
 */
function ordinalSuffix(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * A team's league-wide placement on the stat above it.
 *
 * First place is stated on its own and tinted gold, because that is the whole
 * point of showing it. Anything else has to carry the leader too, or the
 * placement is a number with nothing to measure itself against.
 */
function RankNote({ rank, format }) {
  // The band is always rendered at a fixed height, whether or not there is a
  // placement to put in it. That is what keeps the value's vertical position
  // identical on every panel — previously a tile with a two-line placement
  // pushed its value up relative to its neighbours.
  if (!rank) return <div className="rankline" aria-hidden="true" />;
  const place = `${rank.tied ? "T-" : ""}${ordinalSuffix(rank.place)}`;
  if (rank.place === 1) {
    return <div className="rankline"><span className="first">{place}</span></div>;
  }
  const lead = format ? format(rank.leaderValue) : String(rank.leaderValue);
  return (
    <div className="rankline">
      <span>{place} <span className="ranklead">(1st: {lead}, {rank.leaderTeam})</span></span>
    </div>
  );
}

/**
 * A row of team identities that never wraps, truncates or stacks.
 *
 * One or two fit as they are. Anything wider than the panel becomes a ticker:
 * the row is duplicated and translated at a constant rate, so it reads
 * continuously in one line instead of growing the panel to fit. It is not
 * interactive — it carries identity, not controls.
 */
function TeamStrip({ teams, vs }) {
  const boxRef = useRef(null);
  const rowRef = useRef(null);
  const [ticker, setTicker] = useState(false);

  // Measured imperatively and written straight to the DOM, never through
  // state. Setting state from inside a ResizeObserver re-renders, which
  // changes layout, which fires the observer again — and with one observer per
  // tile that loop is what was taking the page down on expansion. The class is
  // toggled directly, and the measurement is deferred a frame so it can never
  // run inside the observer's own callback.
  useEffect(() => {
    const box = boxRef.current, row = rowRef.current;
    if (!box || !row) return undefined;
    let frame = 0;
    let last = null;
    const apply = () => {
      frame = 0;
      const over = row.scrollWidth > box.clientWidth + 1;
      if (over === last) return;
      last = over;
      box.classList.toggle("running", over);
      setTicker(over);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };
    schedule();
    let ro = null;
    if (typeof ResizeObserver === "function") {
      try { ro = new ResizeObserver(schedule); ro.observe(box); } catch { ro = null; }
    }
    return () => { if (frame) cancelAnimationFrame(frame); if (ro) ro.disconnect(); };
  }, [teams, vs]);

  const chip = (t, i) => (
    <span className="tname" key={`${t.teamId}-${i}`}>
      <TeamLogo src={t.logo} className="lgo" alt="" />
      <i>
        <b>{t.name}</b>
        {t.owner ? <em>{t.owner}</em> : null}
      </i>
    </span>
  );

  // A fixture record is rendered as pairs, so "vs" survives however many
  // pairings are tied for it. Previously the marker only appeared when exactly
  // one pairing held the record, which meant the two matchup records — the ones
  // that are always a fixture — usually showed none at all.
  const items = (key) => {
    if (vs && Array.isArray(vs)) {
      const out = [];
      vs.forEach((pair, pi) => {
        if (pi > 0) out.push(<span className="tname vsgap" key={`gap-${key}-${pi}`}>·</span>);
        out.push(chip(pair[0], `${key}-${pi}a`));
        out.push(<span className="tname vschip" key={`vs-${key}-${pi}`}>vs</span>);
        out.push(chip(pair[1], `${key}-${pi}b`));
      });
      return out;
    }
    return teams.map((t, i) => chip(t, `${key}-${i}`));
  };

  return (
    <div className="tfootnames tickerbox" ref={boxRef}>
      <div className="tickerrow" ref={rowRef}>{items("a")}</div>
      {ticker && <div className="tickerrow" aria-hidden="true">{items("b")}</div>}
    </div>
  );
}

/**
 * The one panel anatomy used everywhere: title pinned top, value optically
 * centred and large, placement beneath it, team identity pinned bottom, and any
 * footnote behind an info button in the corner so it never competes with the
 * value.
 */
function Tile({ label, value, note, names, size, vs, ranks, rankKey, rankFormat }) {
  const [open, setOpen] = useState(false);
  const text = String(value == null ? "—" : value);
  const auto = text.length > 9 ? "small" : (text.length > 6 ? "med" : "");
  const rank = ranks && rankKey ? ranks[rankKey] : null;
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="tile">
      {note && (
        <button className="tinfo" type="button" aria-expanded={open ? "true" : "false"}
          aria-label={`More about ${label}`}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>i</button>
      )}
      {note && open && <div className="tnote">{note}</div>}
      <div className="tlabel">{label}</div>
      <div className="tbody">
        <div className="tvalwrap"><div className={`tvalue gradv ${size || auto}`}>{text}</div></div>
        <RankNote rank={rank} format={rankFormat} />
      </div>
      {names && names.length > 0 && <TeamStrip teams={names} vs={vs} />}
    </div>
  );
}

function SecHead({ children }) {
  return <div className="sechead"><span className="t">{children}</span></div>;
}
function GroupTitle({ children }) {
  return <div className="stgrouptitle"><span>{children}</span></div>;
}
function Placeholder({ title, note }) {
  return <div className="placeholder"><b>{title}</b>{note && <span>{note}</span>}</div>;
}
function TeamName({ row }) {
  return (
    <>
      {row.name}
      {!row.active && (
        <div className="inactivetag">
          Inactive{row.lastActiveSeason ? ` · Last active ${row.lastActiveSeason}` : ""}
        </div>
      )}
    </>
  );
}

/* ====================================================== custom scrollbar */

/**
 * A scrollbar the pointer owns.
 *
 * A native scrollbar could not be kept in step with the table it drives: in
 * some engines a dragged native thumb reports its position only when the
 * gesture ends, so the content sat still and lurched into place on release,
 * and syncing two scroll containers harder only produced an echo loop, because
 * a programmatic scrollLeft write fires the partner's scroll event a frame
 * later. Driving a real element from pointer events removes the loop entirely.
 */
/* ========================================================= sortable table */

/**
 * Sorting replaces rows, never the scrolling element, so a sorted table keeps
 * its horizontal scroll position by construction rather than by restoring it.
 */
function DataTable({ columns, rows, sort, onSort, className, renderRow }) {
  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const col = columns.find((c) => c.key === sort.col);
    if (!col) return rows;
    return rows.slice().sort((a, b) => {
      const av = col.value(a), bv = col.value(b);
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    });
  }, [rows, sort, columns]);

  return (
    <ScrollBox>
      <table className={`datatable ${className || ""}`}>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort.col === c.key;
              return (
                <th key={c.key} className={c.cls || ""}
                  aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}
                  onClick={() => onSort(c.key)}>
                  <span className="lbl">{c.label}</span>
                  <span className="arrow">{active && sort.dir === "asc" ? "▲" : "▼"}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{sorted.map(renderRow)}</tbody>
      </table>
    </ScrollBox>
  );
}

function useSort(initial) {
  const [sort, setSort] = useState(initial);
  const onSort = useCallback((col) => {
    setSort((s) => (s.col === col ? { col, dir: s.dir === "desc" ? "asc" : "desc" } : { col, dir: "desc" }));
  }, []);
  return [sort, onSort];
}

/* =============================================================== motion */

/**
 * One coordinated motion for a whole row of cards.
 *
 * Layout is settled to its final state first — the class change *and* the
 * revealed panel's final height — so nothing reflows mid-flight. Every card
 * that moved or resized is then transformed from where it was to where it now
 * is, on one shared duration derived from the largest delta at a fixed rate.
 * Each card's inner wrapper is counter-scaled so a card stretches without its
 * text stretching with it.
 *
 * The inverse transform is applied inline and flushed before the animations are
 * created. Without that the browser paints one frame of the final layout first,
 * which is a visible stutter at the start of every expansion.
 *
 * Deliberately NOT split into a transform plus a real height animation. That
 * was tried to cure the dropped frames on mobile and was far worse: animating
 * height on every card in a row forces layout for the whole grid every frame,
 * and on a phone it crashed the page outright. The awkward mobile easing is
 * the accepted trade for a page that stays up.
 */
function flipRow(row, mutate, onDone) {
  if (!row) { mutate(); if (onDone) onDone(); return; }
  const cards = Array.from(row.children);
  const first = cards.map((el) => el.getBoundingClientRect());
  mutate();
  if (stillnessOn() || coarsePointer()) { if (onDone) onDone(); return; }
  const last = cards.map((el) => el.getBoundingClientRect());

  const moved = [];
  let maxDelta = 0;
  cards.forEach((el, i) => {
    const f = first[i], l = last[i];
    if (!l.width || !l.height || !f.width || !f.height) return;
    const dx = f.left - l.left, dy = f.top - l.top;
    const sx = f.width / l.width, sy = f.height / l.height;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 &&
        Math.abs(sx - 1) < 0.004 && Math.abs(sy - 1) < 0.004) return;
    maxDelta = Math.max(maxDelta, Math.abs(dx), Math.abs(dy),
      Math.abs(f.width - l.width), Math.abs(f.height - l.height));
    const inner = el.querySelector(".cardinner, .oppinner");
    const t = `translate(${dx}px,${dy}px) scale(${sx},${sy})`;
    el.style.transformOrigin = "top left";
    el.style.transform = t;
    el.style.willChange = "transform";
    if (inner) {
      inner.style.transformOrigin = "top left";
      inner.style.transform = `scale(${1 / sx},${1 / sy})`;
    }
    moved.push({ el, inner, t });
  });
  if (!moved.length) { if (onDone) onDone(); return; }

  const dur = Math.max(MIN_MS, Math.min(MAX_MS, maxDelta / EXPAND_RATE));
  void row.offsetWidth;   // flush the inverted state before animating away from it

  let done = 0;
  moved.forEach(({ el, inner, t }) => {
    const a = el.animate([{ transform: t }, { transform: "none" }], { duration: dur, easing: EASE });
    if (inner) {
      const s = inner.style.transform;
      inner.animate([{ transform: s }, { transform: "none" }], { duration: dur, easing: EASE });
    }
    a.onfinish = () => {
      el.style.transform = ""; el.style.willChange = "";
      if (inner) inner.style.transform = "";
      done += 1;
      if (done >= moved.length && onDone) onDone();
    };
  });
}

/* There was a forced scroll here that pulled the opened card to the top of the
   viewport. It never behaved on either platform — it fought the expand
   animation on desktop and compounded the mobile trouble — so the page now
   simply expands in place and leaves the scroll position alone. */

function setPanelOpen(panel, open) {
  if (!panel) return;
  if (!open) { panel.style.height = "0px"; return; }
  panel.style.height = "auto";
  const h = panel.getBoundingClientRect().height;
  panel.style.height = `${h}px`;
}

/* ============================================================== sections */

function Champions({ champions, byId }) {
  if (!champions || !champions.length) {
    return (
      <>
        <SecHead>Champions</SecHead>
        <Placeholder title="No champions crowned yet"
          note="This league hasn't finished a season." />
      </>
    );
  }
  return (
    <>
      <SecHead>Champions</SecHead>
      <ScrollBox>
        <div className="champrow">
          {champions.map((c, i) => {
            const row = c.teamId != null ? byId[c.teamId] : null;
            return (
              <div className="champcard" key={`${c.year}-${c.teamId ?? "x"}-${i}`}>
                <div className="champyear">{row ? `${c.year} Champion` : c.year}</div>
                {row ? (
                  <>
                    <div className="champbody">
                      <TeamLogo src={row.logo} className="lgo champlogo" alt="" />
                      <div className="champname gradv">{row.name}</div>
                    </div>
                    <div className="champowner">{row.owner || "\u00a0"}</div>
                  </>
                ) : (
                  <>
                    <div className="champbody">
                      <div className="placeholder chplace"><b>Season<br />in progress</b></div>
                    </div>
                    <div className="champowner">&nbsp;</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </ScrollBox>
    </>
  );
}

/* Records that describe a fixture rather than a team: shown as logo / name /
   vs / name / logo rather than as a list of chips. */
const VS_RECORDS = new Set(["biggestBlowout", "closestGame", "mostLopsidedMatchup", "closestMatchup"]);

const RECORD_ORDER = [
  ["mostChampionships", "Most Championships", (v) => String(v.value)],
  ["highestWinPct", "Highest Win %", (v) => pct(v.value)],
  ["bestAvgFinish", "Best Avg Finish", (v) => Number(v.value).toFixed(1)],
  ["mostPoints", "Most Points (Career)", (v) => num1(v.value)],
  ["bestDiff", "Best Point Diff (Career)", (v) => signed(v.value)],
  ["mostPlayoffApps", "Most Playoff Apps", (v) => String(v.value)],
  ["longestWinStreak", "Longest Win Streak (Games)", (v) => String(v.value)],
  ["longestLossStreak", "Longest Losing Streak (Games)", (v) => String(v.value)],
  ["highestSingleGame", "Highest Matchup Score", (v) => num1(v.points)],
  ["lowestSingleGame", "Lowest Matchup Score", (v) => num1(v.points)],
  ["biggestBlowout", "Biggest Blowout (Margin)", (v) => num1(v.margin)],
  ["closestGame", "Closest Game (Margin)", (v) => num1(v.margin)],
  ["mostLopsidedMatchup", "Most Lopsided Matchup", (v) => pct(v.winPct)],
  ["closestMatchup", "Closest Matchup", (v) => pct(v.winPct)],
  ["mostTransactions", "Most Transactions (Career)", (v) => String(v.value)],
  ["mostTrades", "Most Trades (Career)", (v) => String(v.value)],
];

function recordNote(key, holders) {
  const n = holders.length;
  const tie = n > 1 ? `${n === 2 ? "Two" : n === 3 ? "Three" : n}-way tie. ` : "";
  const h = holders[0];
  switch (key) {
    case "bestAvgFinish": return `${tie}Mean final placement. Floor: minimum 2 completed seasons.`;
    case "longestWinStreak": case "longestLossStreak":
      return h.at ? `${tie}${h.at.season} Wk ${h.at.week} – ${h.at.endSeason} Wk ${h.at.endWeek}. Streaks run continuously across season boundaries.` : tie || null;
    // A playoff matchup in this league can span two scoring periods, so its
    // total is a two-week figure. Saying "matchup" rather than "game", and
    // saying so here, is what keeps the number honest against the one-week
    // regular-season scores sitting beside it.
    case "highestSingleGame": case "lowestSingleGame":
      return `${tie}${h.season} Wk ${h.week}. Playoff matchups can run two weeks, so a postseason total may cover both.`;
    case "biggestBlowout": case "closestGame":
      return `${tie}${h.season} Wk ${h.week}. Margins are per matchup; a playoff matchup can run two weeks.`;
    case "mostLopsidedMatchup":
      return `${tie}Leads the all-time series ${h.record}. Floor: minimum 3 meetings.`;
    case "closestMatchup":
      return `${tie}All-time series stands at ${h.record}. Floor: minimum 3 meetings.`;
    default: return tie || null;
  }
}
function recordTeams(key, holders, byId) {
  const ids = [];
  for (const h of holders) {
    if (h.teamId != null) ids.push(h.teamId);
    else if (key === "biggestBlowout") { ids.push(h.winner); ids.push(h.loser); }
    else if (key === "closestGame") { ids.push(h.teamA); ids.push(h.teamB); }
    else if (h.dominantTeam != null) {
      ids.push(h.dominantTeam);
      ids.push(h.dominantTeam === h.teamA ? h.teamB : h.teamA);
    }
  }
  const seen = new Set();
  return ids.filter((id) => (seen.has(id) ? false : seen.add(id)))
    .map((id) => byId[id]).filter(Boolean);
}

/** Fixture records as ordered pairs — winner or dominant side first. */
function recordPairs(key, holders, byId) {
  if (!VS_RECORDS.has(key)) return null;
  const out = [];
  for (const h of holders) {
    let a = null, b = null;
    if (key === "biggestBlowout") { a = h.winner; b = h.loser; }
    else if (key === "closestGame") { a = h.teamA; b = h.teamB; }
    else if (h.dominantTeam != null) {
      a = h.dominantTeam;
      b = h.dominantTeam === h.teamA ? h.teamB : h.teamA;
    }
    if (byId[a] && byId[b]) out.push([byId[a], byId[b]]);
  }
  return out.length ? out : null;
}

function LeagueRecords({ records, byId }) {
  const present = RECORD_ORDER.filter(([key]) => (records[key] || []).length);
  if (!present.length) {
    return (
      <>
        <SecHead>League Records</SecHead>
        <Placeholder title="No records yet" note="Records appear once a season has been played." />
      </>
    );
  }
  return (
    <>
      <SecHead>League Records</SecHead>
      <div className="rowgrid">
        {RECORD_ORDER.map(([key, label, fmt]) => {
          const holders = records[key] || [];
          if (!holders.length) {
            return (
              <div className="tile" key={key}>
                <div className="tlabel">{label}</div>
                <div className="tbody"><Placeholder title="Not enough data" /></div>
                <div className="tfootnames" />
              </div>
            );
          }
          return (
            <Tile key={key} label={label} value={fmt(holders[0])}
              note={recordNote(key, holders)}
              names={recordTeams(key, holders, byId)}
              vs={recordPairs(key, holders, byId)} />
          );
        })}
      </div>
    </>
  );
}

/* -------------------------------------------------------- standings ---- */

function standingsColumns(phase) {
  // The phase-specific figures come from the row's phase block; placement,
  // identity and season-level outcomes are properties of a career and do not
  // split, so they read the same whichever phase is selected.
  const ph = (r) => r.phases[phase] || r.phases.all;
  return [
    { key: "rank", label: "Rank", value: (r) => ph(r).record.winPct },
    { key: "team", label: "Team", cls: "col-team", value: (r) => r.name.toLowerCase() },
    { key: "seasons", label: "Seasons", value: (r) => r.seasons[0] || 0 },
    { key: "record", label: "W-L-T", value: (r) => ph(r).record.wins },
    { key: "winpct", label: "Win %", value: (r) => ph(r).record.winPct },
    { key: "pf", label: "PF", value: (r) => ph(r).points.for },
    { key: "pa", label: "PA", value: (r) => ph(r).points.against },
    { key: "diff", label: "Diff", value: (r) => ph(r).points.diff },
    { key: "ppg", label: "PPG", value: (r) => ph(r).points.perGame },
    { key: "streak", label: "Streak", value: (r) => (r.streak ? r.streak.length * (r.streak.type === "W" ? 1 : -1) : 0) },
    { key: "champs", label: "Titles", value: (r) => r.championships.count },
    { key: "playoffapps", label: "Playoff Apps", value: (r) => (r.postseason.seasonsPlayed ? r.postseason.appearances / r.postseason.seasonsPlayed : -1) },
    { key: "avgfinish", label: "Avg Finish", value: (r) => -(r.avgFinish == null ? 99 : r.avgFinish) },
    { key: "bestfinish", label: "Best Finish", value: (r) => -(r.bestFinish ? r.bestFinish.rank : 99) },
  ];
}

function Standings({ rows, seasonMeta }) {
  const [sort, onSort] = useSort({ col: "winpct", dir: "desc" });
  const [phase, setPhase] = useState("all");
  const hasPost = rows.some((r) => r.phases && r.phases.post.record.games > 0);
  const active = hasPost || phase !== "post" ? phase : "all";
  const columns = useMemo(() => standingsColumns(active), [active]);
  if (!rows.length) {
    return (
      <>
        <SecHead>All-Time Standings</SecHead>
        <Placeholder title="No seasons completed yet"
          note="Standings populate once games have been played." />
      </>
    );
  }
  let i = 0;
  const renderRow = (r) => {
    i += 1;
    const ph = r.phases[active] || r.phases.all;
    const played = ph.record.games > 0;
    const span = r.active
      ? `${r.seasons[0]}–present`
      : `${r.seasons[0]}–${r.seasons[r.seasons.length - 1]}`;
    return (
      <tr key={r.teamId}>
        <td className="c-rank gradv">{i}</td>
        <td className="col-team">
          <div className="stname">
            <TeamLogo src={r.logo} className="lgo" alt="" />
            <div className="stnamewrap">
              <b><TeamName row={r} /></b>
              {r.owner ? <em className="cardowner">{r.owner}</em> : null}
            </div>
          </div>
        </td>
        <td className="c-muted">{span}</td>
        <td className="c-key">{ph.record.wins}-{ph.record.losses}-{ph.record.ties}</td>
        <td className="c-key">{played ? pct(ph.record.winPct) : "—"}</td>
        <td className="c-num">{num1(ph.points.for)}</td>
        <td className="c-num">{num1(ph.points.against)}</td>
        <td className={ph.points.diff >= 0 ? "c-pos" : "c-neg"}>{signed(ph.points.diff)}</td>
        <td className="c-num">{played ? num1(ph.points.perGame) : "—"}</td>
        <td className={!r.record.games || !r.streak ? "c-muted" : (r.streak.type === "W" ? "c-pos" : "c-neg")}>
          {r.record.games && r.streak ? `${r.streak.type}${r.streak.length}${r.streak.final ? " (final)" : ""}` : "—"}
        </td>
        <td className={r.championships.count ? "c-gold" : "c-muted"}>{r.championships.count || "—"}</td>
        <td className="c-num">{r.postseason.seasonsPlayed ? `${r.postseason.appearances} of ${r.postseason.seasonsPlayed}` : "—"}</td>
        <td className="c-num">{r.avgFinish == null ? "—" : r.avgFinish.toFixed(1)}</td>
        <td className="c-muted">
          {r.bestFinish
            ? `${finishLabel(r.bestFinish, (seasonMeta[r.bestFinish.year] || {}).size)} ${yy(r.bestFinish.year)}`
            : "—"}
        </td>
      </tr>
    );
  };
  return (
    <>
      <SecHead>All-Time Standings</SecHead>
      <PhaseTabs value={active} onChange={setPhase} hasPost={hasPost} />
      <DataTable columns={columns} rows={rows} sort={sort} onSort={onSort} renderRow={renderRow} />
    </>
  );
}

/* --------------------------------------------------------- head to head */

function seriesFor(teamId, oppId, pairs) {
  const p = pairs[pairKey(teamId, oppId)];
  if (!p) return null;
  const games = (p.lowWins || 0) + (p.highWins || 0) + (p.ties || 0);
  if (!games) return null;
  const isLow = teamId < oppId;
  const side = (bucket) => {
    const b = bucket || {};
    const w = isLow ? (b.lowWins || 0) : (b.highWins || 0);
    const l = isLow ? (b.highWins || 0) : (b.lowWins || 0);
    const t = b.ties || 0;
    const n = w + l + t;
    return {
      games: n, wins: w, losses: l, ties: t,
      pf: isLow ? (b.lowPoints || 0) : (b.highPoints || 0),
      pa: isLow ? (b.highPoints || 0) : (b.lowPoints || 0),
      winPct: n ? (w + t * 0.5) / n : 0,
    };
  };
  // Each fixture is decomposed into its scoring periods, so a postseason
  // matchup that ran two weeks contributes two weekly scores rather than one
  // doubled one — the same normalisation the record book uses.
  const log = (p.games || []).map((g) => ({
    season: g.season, week: g.week, round: g.round, postseason: Boolean(g.postseason),
    own: isLow ? g.lowPts : g.highPts,
    opp: isLow ? g.highPts : g.lowPts,
    weeks: (g.weeks || [{ period: g.week, lowPts: g.lowPts, highPts: g.highPts }]).map((w) => ({
      period: w.period,
      own: isLow ? w.lowPts : w.highPts,
      opp: isLow ? w.highPts : w.lowPts,
      season: g.season,
    })),
  }));
  // Current run in this series, read from the tail of the chronology.
  let type = null, len = 0;
  for (let k = log.length - 1; k >= 0; k -= 1) {
    const res = log[k].own > log[k].opp ? "W" : (log[k].own < log[k].opp ? "L" : "T");
    if (type === null) { type = res; len = 1; } else if (res === type) len += 1; else break;
  }
  const all = side(p);
  return {
    ...all,
    log, streak: type ? { type, length: len } : null,
    phases: { all, regular: side(p.regular), post: side(p.post) },
  };
}

/**
 * The scoring superlatives for one phase of a series.
 *
 * Computed from weekly scores rather than matchup totals, for the same reason
 * the record book does: a two-week postseason matchup would otherwise report a
 * combined score and a margin that no single week produced.
 */
function seriesExtremes(log, phase) {
  const games = phase === "all" ? log : log.filter((g) => (phase === "post" ? g.postseason : !g.postseason));
  const weeks = games.flatMap((g) => g.weeks);
  if (!weeks.length) return null;
  const pick = (arr, val, higher) => arr.reduce((best, x) =>
    (best === null || (higher ? val(x) > val(best) : val(x) < val(best)) ? x : best), null);
  const margin = (w) => Math.abs(w.own - w.opp);
  const combined = (w) => w.own + w.opp;
  return {
    meetings: games.length,
    closest: pick(weeks, margin, false),
    biggest: pick(weeks, margin, true),
    shootout: pick(weeks, combined, true),
    slugfest: pick(weeks, combined, false),
    first: games[0],
    last: games[games.length - 1],
  };
}

const MINI_COLS = [
  { key: "team", label: "Team", cls: "col-team", value: (r) => r.name.toLowerCase() },
  { key: "record", label: "W-L-T", value: (r) => r.w },
  { key: "winpct", label: "Win %", value: (r) => (r.w + r.t * 0.5) / Math.max(1, r.w + r.l + r.t) },
  { key: "pf", label: "PF", value: (r) => r.pf },
  { key: "pa", label: "PA", value: (r) => r.pa },
  { key: "diff", label: "Diff", value: (r) => r.pf - r.pa },
  { key: "streak", label: "Streak", value: (r) => r.streakVal },
];
const LOG_COLS = (ownAbbrev, oppAbbrev) => [
  { key: "season", label: "Season", value: (g) => g.season * 100 + (g.week || 0) },
  { key: "week", label: "Week", value: (g) => g.week || 0 },
  { key: "own", label: `${ownAbbrev} Pts`, value: (g) => g.own },
  { key: "opp", label: `${oppAbbrev} Pts`, value: (g) => g.opp },
  { key: "result", label: "Result", value: (g) => (g.own > g.opp ? 1 : 0) },
  { key: "round", label: "Round", value: (g) => (g.round ? 1 : 0) },
];

/**
 * A phase selector for a table.
 *
 * The panels elsewhere on this page carry their regular-season and postseason
 * versions side by side, which works because a panel holds one number. A table
 * holds a dozen columns, so doubling them would make it unreadable; the same
 * information is offered by switching the table instead.
 */
function PhaseTabs({ value, onChange, hasPost }) {
  const opts = [["all", "All time"], ["regular", "Regular season"], ["post", "Postseason"]];
  return (
    <div className="phasetabs" role="tablist">
      {opts.map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k}
          className={`phasetab${value === k ? " on" : ""}`}
          disabled={k === "post" && !hasPost}
          onClick={(e) => { e.stopPropagation(); onChange(k); }}>{label}</button>
      ))}
    </div>
  );
}

function SeriesDetail({ team, opp, series }) {
  const [miniSort, onMiniSort] = useSort({ col: "winpct", dir: "desc" });
  const [logSort, onLogSort] = useSort({ col: "season", dir: "asc" });
  const [phase, setPhase] = useState("all");
  const hasPost = series.phases.post.games > 0;
  const view = series.phases[hasPost || phase !== "post" ? phase : "all"];

  const miniRows = useMemo(() => {
    const onStreak = series.streak && series.streak.type === "W";
    const len = series.streak ? series.streak.length : 0;
    const showStreak = phase === "all";
    return [
      { ...team, w: view.wins, l: view.losses, t: view.ties, pf: view.pf, pa: view.pa,
        streak: showStreak && series.streak ? `${series.streak.type}${len}` : "—",
        streakVal: onStreak ? len : -len },
      { ...opp, w: view.losses, l: view.wins, t: view.ties, pf: view.pa, pa: view.pf,
        streak: showStreak && series.streak ? `${onStreak ? "L" : "W"}${len}` : "—",
        streakVal: onStreak ? -len : len },
    ];
  }, [team, opp, series, view, phase]);

  const regular = useMemo(() => seriesExtremes(series.log, "regular"), [series]);
  const post = useMemo(() => seriesExtremes(series.log, "post"), [series]);

  const renderMini = (r) => (
    <tr key={r.teamId}>
      <td className="col-team">
        <div className="stname">
          <TeamLogo src={r.logo} className="lgo" alt="" />
          <div className="stnamewrap"><b><TeamName row={r} /></b></div>
        </div>
      </td>
      <td className="c-key">{r.w}-{r.l}-{r.t}</td>
      <td className="c-key">{pct((r.w + r.t * 0.5) / Math.max(1, r.w + r.l + r.t))}</td>
      <td className="c-num">{num1(r.pf)}</td>
      <td className="c-num">{num1(r.pa)}</td>
      <td className={r.pf - r.pa >= 0 ? "c-pos" : "c-neg"}>{signed(r.pf - r.pa)}</td>
      <td className={r.streakVal >= 0 ? "c-pos" : "c-neg"}>{r.streak}</td>
    </tr>
  );
  const renderLog = (g, idx) => {
    const won = g.own > g.opp;
    return (
      <tr key={`${g.season}-${g.week}-${idx}`}>
        <td className="c-key">{g.season}</td>
        <td className="c-muted">Wk {g.week}</td>
        <td className={won ? "c-pos" : "c-num"}>{num1(g.own)}</td>
        <td className={won ? "c-num" : "c-pos"}>{num1(g.opp)}</td>
        <td><span className={`wl ${won ? "w" : "l"}`}>{won ? "W" : "L"}</span></td>
        <td>{g.round ? <span className="pfchip">{g.round}</span> : <span className="c-muted">—</span>}</td>
      </tr>
    );
  };

  /* Each superlative appears twice, regular season then postseason, because a
     two-week postseason fixture and a one-week regular-season one are not
     comparable quantities. A pairing that has met only in one phase gets a
     placeholder in the other rather than a blank or a misleading zero. */
  const pairOfTiles = (label, get, fmt, noteOf) => {
    const cell = (stats, suffix, phaseLabel) => {
      if (!stats) {
        return (
          <div className="tile" key={`${label}-${suffix}`}>
            <div className="tlabel">{label} ({suffix})</div>
            <div className="tbody"><Placeholder title={`No ${phaseLabel} meetings`} /></div>
            <div className="tfootnames" />
          </div>
        );
      }
      const w = get(stats);
      return (
        <Tile key={`${label}-${suffix}`} label={`${label} (${suffix})`}
          value={fmt(w)} note={noteOf(w, stats)} />
      );
    };
    return [cell(regular, "Regular Season", "regular-season"), cell(post, "Postseason", "postseason")];
  };

  const at = (w) => `${w.season} Wk ${w.period}`;

  return (
    <div className="oppdetail-inner">
      <PhaseTabs value={phase} onChange={setPhase} hasPost={hasPost} />
      <DataTable columns={MINI_COLS} rows={miniRows} sort={miniSort} onSort={onMiniSort}
        renderRow={renderMini} />
      {(regular || post) && (
        <>
          <GroupTitle>In This Series</GroupTitle>
          <div className="rowgrid">
            {pairOfTiles("Closest Game", (s2) => s2.closest,
              (w) => num1(Math.abs(w.own - w.opp)),
              (w) => `${at(w)} — the narrowest single week between these two.`)}
            {pairOfTiles("Biggest Margin", (s2) => s2.biggest,
              (w) => num1(Math.abs(w.own - w.opp)),
              (w) => `${at(w)}.`)}
            {pairOfTiles("Shootout (Combined)", (s2) => s2.shootout,
              (w) => num1(w.own + w.opp),
              (w) => `${at(w)} — highest combined score in a single week.`)}
            {pairOfTiles("Slugfest (Combined)", (s2) => s2.slugfest,
              (w) => num1(w.own + w.opp),
              (w) => `${at(w)} — lowest combined score in a single week.`)}
            {pairOfTiles("First Meeting", (s2) => s2.first,
              (g) => String(g.season), (g) => `Week ${g.week}.`)}
            {pairOfTiles("Most Recent", (s2) => s2.last,
              (g) => String(g.season), (g) => `Week ${g.week}.`)}
          </div>
          <GroupTitle>Full Game Log</GroupTitle>
          <DataTable className="gamelog" columns={LOG_COLS(team.abbrev || "Team", opp.abbrev || "Opp")}
            rows={series.log} sort={logSort} onSort={onLogSort} renderRow={renderLog} />
        </>
      )}
    </div>
  );
}

function OppCard({ team, opp, series, openSet, onToggle, expandAll }) {
  const cardRef = useRef(null);
  const panelRef = useRef(null);
  const open = expandAll || openSet.has(opp.teamId);

  useEffect(() => {
    if (expandAll && panelRef.current) panelRef.current.style.height = "auto";
  }, [expandAll]);

  const toggle = (e) => {
    if (e.target.closest(".scrollwrap") || e.target.closest(".tinfo")) return;
    e.stopPropagation();
    const card = cardRef.current, panel = panelRef.current;
    const row = card.parentElement;
    const outer = card.closest(".teamdetail");
    const next = !open;
    // The outer panel is released to auto height first, so a nested panel can
    // grow it rather than being clipped by a height measured before it existed.
    if (outer) outer.style.height = "auto";
    flipRow(row, () => {
      card.classList.toggle("expanded", next);
      setPanelOpen(panel, next);
    }, () => {
      if (next && panel) panel.style.height = "auto";
    });
    onToggle(opp.teamId);
  };

  return (
    <div className={`oppcard${open ? " expanded" : ""}`} ref={cardRef}
      aria-expanded={open ? "true" : "false"} role="button" tabIndex={0} onClick={toggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e); } }}>
      <div className="oppinner">
        <div className="opp-head">
          <TeamLogo src={opp.logo} className="lgo" alt="" />
          <div className="opp-name">
            <TeamName row={opp} />
            {opp.owner ? <em className="cardowner">{opp.owner}</em> : null}
          </div>
        </div>
        {series ? (
          <>
            <div className="opp-mid">
              <div className="opp-pct gradv">{pct(series.winPct)}</div>
              <div className="opp-sub">Win rate</div>
            </div>
            <div className="opp-foot">{series.wins}-{series.losses}-{series.ties}</div>
          </>
        ) : (
          <>
            <div className="opp-mid">
              <div className="placeholder oppplace"><b>Never played</b></div>
            </div>
            <div className="opp-foot">&nbsp;</div>
          </>
        )}
        <span className="chev bottomchev" aria-hidden="true" />
        <div className="oppdetail" ref={panelRef} style={{ height: open ? "auto" : 0 }}>
          {series
            ? <SeriesDetail team={team} opp={opp} series={series} />
            : (
              <div className="oppdetail-inner">
                <Placeholder title="No meetings on record"
                  note={`${team.name} and ${opp.name} have never played — their time in the league doesn't overlap.`} />
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

const SEASONLOG_COLS = [
  { key: "year", label: "Year", value: (r) => r.year },
  { key: "record", label: "W-L-T", value: (r) => r.wins },
  { key: "winpct", label: "Win %", value: (r) => r.wins / Math.max(1, r.wins + r.losses + r.ties) },
  { key: "pf", label: "PF", value: (r) => r.pf },
  { key: "pa", label: "PA", value: (r) => r.pa },
  { key: "finish", label: "Finish", value: (r) => -(r.rank || 99) },
];

function TeamDetail({ row, rows, pairs, expandAll }) {
  const [seasonSort, onSeasonSort] = useSort({ col: "year", dir: "asc" });
  const [openSet, setOpenSet] = useState(() => new Set());
  const onToggle = useCallback((id) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const played = row.record.games > 0;
  const opponents = useMemo(() => rows
    .filter((o) => o.teamId !== row.teamId)
    .map((o) => ({ opp: o, series: played ? seriesFor(row.teamId, o.teamId, pairs) : null }))
    .sort((a, b) => (b.series ? b.series.winPct : -1) - (a.series ? a.series.winPct : -1)),
  [rows, row, pairs, played]);

  const renderSeason = (s) => (
    <tr key={s.year}>
      <td className="c-key">{s.year}</td>
      <td className="c-key">{s.wins}-{s.losses}-{s.ties}</td>
      <td className="c-num">{pct(s.wins / Math.max(1, s.wins + s.losses + s.ties))}</td>
      <td className="c-num">{num1(s.pf)}</td>
      <td className="c-num">{num1(s.pa)}</td>
      <td className={s.rank && s.rank <= 3 ? "c-gold" : "c-muted"}>
        {finishLabel({ rank: s.rank }, s.size)}
      </td>
    </tr>
  );

  /* No team-identity chips anywhere in this panel: every stat here belongs to
     the team whose card it is, so a chip on each one would repeat the card
     heading a dozen times over. */
  return (
    <div className="teamdetail-inner">
      {played ? (
        <>
          <GroupTitle>Career Record</GroupTitle>
          <div className="rowgrid">
            <Tile label="All-Time W-L-T" value={`${row.record.wins}-${row.record.losses}-${row.record.ties}`}
              rankKey="record.wins" ranks={row.ranks} rankFormat={(v) => `${v} W`} />
            <Tile label="Win %" value={pct(row.record.winPct)}
              rankKey="record.winPct" ranks={row.ranks} rankFormat={pct} />
            <Tile label="Win % (Regular Season)" value={pct(row.phases.regular.record.winPct)}
              rankKey="regular.record.winPct" ranks={row.ranks} rankFormat={pct}
              note={`Regular-season record: ${row.phases.regular.record.wins}-${row.phases.regular.record.losses}-${row.phases.regular.record.ties}.`} />
            {row.phases.post.record.games > 0 ? (
              <Tile label="Win % (Postseason)" value={pct(row.phases.post.record.winPct)}
                rankKey="post.record.winPct" ranks={row.ranks} rankFormat={pct}
                note={`Postseason record: ${row.phases.post.record.wins}-${row.phases.post.record.losses}-${row.phases.post.record.ties}. Championship bracket and consolation ladder alike.`} />
            ) : (
              <div className="tile">
                <div className="tlabel">Win % (Postseason)</div>
                <div className="tbody"><Placeholder title="No postseason games" /></div>
                <div className="tfootnames" />
              </div>
            )}
            <Tile label="Total Games" value={String(row.record.games)}
              rankKey="record.games" ranks={row.ranks} />
            <Tile label="Longest Win Streak" value={String(row.bestWinStreak ? row.bestWinStreak.length : 0)}
              rankKey="bestWinStreak" ranks={row.ranks}
              note={row.bestWinStreak ? `${row.bestWinStreak.season} Wk ${row.bestWinStreak.week} – ${row.bestWinStreak.endSeason} Wk ${row.bestWinStreak.endWeek}. Streaks run continuously across season boundaries.` : null} />
            <Tile label="Longest Losing Streak" value={String(row.worstLossStreak ? row.worstLossStreak.length : 0)}
              rankKey="worstLossStreak" ranks={row.ranks}
              note={row.worstLossStreak ? `${row.worstLossStreak.season} Wk ${row.worstLossStreak.week} – ${row.worstLossStreak.endSeason} Wk ${row.worstLossStreak.endWeek}. Fewest is best.` : null} />
            <Tile label="Current Streak" value={row.streak ? `${row.streak.type}${row.streak.length}` : "—"}
              note={row.streak && row.streak.final ? "Final — this team is no longer active." : null} />
          </div>

          <GroupTitle>Scoring</GroupTitle>
          <div className="rowgrid">
            <Tile label="Points For (Career)" value={num1(row.points.for)}
              rankKey="points.for" ranks={row.ranks} rankFormat={num1} />
            <Tile label="Points Against (Career)" value={num1(row.points.against)}
              rankKey="points.against" ranks={row.ranks} rankFormat={num1}
              note="Fewest is best." />
            <Tile label="Points Per Game" value={num1(row.points.perGame)}
              rankKey="points.perGame" ranks={row.ranks} rankFormat={num1}
              note="Points for, divided by scoring periods played. A postseason matchup that ran two weeks counts as two." />
            <Tile label="Points Per Game (Regular Season)" value={num1(row.phases.regular.points.perGame)}
              rankKey="regular.points.perGame" ranks={row.ranks} rankFormat={num1} />
            {row.phases.post.points.weeks > 0 ? (
              <Tile label="Points Per Game (Postseason)" value={num1(row.phases.post.points.perGame)}
                rankKey="post.points.perGame" ranks={row.ranks} rankFormat={num1} />
            ) : (
              <div className="tile">
                <div className="tlabel">Points Per Game (Postseason)</div>
                <div className="tbody"><Placeholder title="No postseason games" /></div>
                <div className="tfootnames" />
              </div>
            )}
            <Tile label="Point Differential" value={signed(row.points.diff)}
              rankKey="points.diff" ranks={row.ranks} rankFormat={signed} />
            <Tile label="Best Week" value={row.phases.all.high ? num1(row.phases.all.high.points) : "—"}
              note={row.phases.all.high ? `${row.phases.all.high.season} Wk ${row.phases.all.high.week}. A single scoring period, never a two-week total.` : null} />
            <Tile label="Worst Week" value={row.phases.all.low ? num1(row.phases.all.low.points) : "—"}
              note={row.phases.all.low ? `${row.phases.all.low.season} Wk ${row.phases.all.low.week}.` : null} />
          </div>

          <GroupTitle>Postseason</GroupTitle>
          <div className="rowgrid">
            <Tile label="Playoff Appearances"
              value={row.postseason.seasonsPlayed ? `${row.postseason.appearances} of ${row.postseason.seasonsPlayed}` : "—"}
              rankKey="postseason.appearances" ranks={row.ranks} />
            <Tile label="Postseason Record" value={`${row.postseason.wins}-${row.postseason.losses}`}
              note="Every game after the regular season, championship bracket and consolation ladder alike." />
            <Tile label="Championships" value={String(row.championships.count)}
              rankKey="championships" ranks={row.ranks}
              note={row.championships.count ? `Won in ${row.championships.years.join(", ")}.` : "None yet."} />
            <Tile label="Runner-Up Finishes" value={String(row.runnerUp.count)}
              rankKey="runnerUp" ranks={row.ranks}
              note={row.runnerUp.count ? `Runner-up in ${row.runnerUp.years.join(", ")}.` : "None yet."} />
            <Tile label="Third-Place Finishes" value={String(row.thirdPlace.count)}
              rankKey="thirdPlace" ranks={row.ranks}
              note={row.thirdPlace.count ? `Third in ${row.thirdPlace.years.join(", ")}.` : "None yet."} />
            <Tile label="Last-Place Finishes" value={String(row.lastPlace.count)}
              rankKey="lastPlace" ranks={row.ranks}
              note={row.lastPlace.count ? `Finished bottom in ${row.lastPlace.years.join(", ")}.` : "None yet."} />
            <Tile label="Best Season Finish" value={finishLabel(row.bestFinish, null)}
              note={row.bestFinish ? `Achieved in ${row.bestFinish.year}.` : null} />
            <Tile label="Worst Season Finish" value={finishLabel(row.worstFinish, null)}
              note={row.worstFinish ? `Recorded in ${row.worstFinish.year}.` : null} />
            <Tile label="Average Finish" value={row.avgFinish == null ? "—" : row.avgFinish.toFixed(1)}
              rankKey="avgFinish" ranks={row.ranks} rankFormat={(v) => Number(v).toFixed(1)}
              note="Mean final placement across completed seasons. Lowest is best." />
          </div>

          <GroupTitle>Season by Season</GroupTitle>
          <DataTable columns={SEASONLOG_COLS} rows={row.seasonLog} sort={seasonSort}
            onSort={onSeasonSort} renderRow={renderSeason} />
        </>
      ) : (
        <>
          <GroupTitle>Career Record, Scoring &amp; Postseason</GroupTitle>
          <Placeholder title="No games played yet"
            note={`${row.name} hasn't finished a game — these sections populate once the season is underway.`} />
        </>
      )}

      <GroupTitle>Front Office</GroupTitle>
      <div className="rowgrid">
        <Tile label="Total Transactions"
          value={String(row.transactions.acquisitions + row.transactions.drops + row.transactions.trades)}
          rankKey="transactions.total" ranks={row.ranks}
          note="Acquisitions, drops and trades combined." />
        <Tile label="Trades" value={String(row.transactions.trades)}
          rankKey="transactions.trades" ranks={row.ranks} />
        <Tile label="Waiver Acquisitions" value={String(row.transactions.acquisitions)}
          rankKey="transactions.acquisitions" ranks={row.ranks} />
      </div>

      <GroupTitle>Head to Head</GroupTitle>
      <div className="rowgrid oppgrid">
        {opponents.map(({ opp, series }) => (
          <OppCard key={opp.teamId} team={row} opp={opp} series={series}
            openSet={openSet} onToggle={onToggle} expandAll={expandAll} />
        ))}
      </div>
    </div>
  );
}

function MedalTray({ row, seasonMeta }) {
  const medals = [];
  row.championships.years.forEach((y) => medals.push(["gold", y, `Champion, ${y}`]));
  row.runnerUp.years.forEach((y) => medals.push(["silver", y, `Runner-up, ${y}`]));
  row.thirdPlace.years.forEach((y) => medals.push(["bronze", y, `Third place, ${y}`]));

  /* A team with no top-three finish would otherwise leave the tray empty — a
     visible hole created purely by standardising the card height. Its best
     placement fills the space instead, reading as one more figure on the card
     rather than as an apology for the absent medals. */
  if (!medals.length) {
    if (!row.bestFinish) return <div className="tc-badges" />;
    const size = (seasonMeta[row.bestFinish.year] || {}).size;
    return (
      <div className="tc-badges">
        <div className="bestfin">
          Best Finish: <b>{finishLabel(row.bestFinish, size)} {yy(row.bestFinish.year)}</b>
        </div>
      </div>
    );
  }
  return (
    <div className="tc-badges">
      {medals.map(([kind, year, title]) => (
        <span className={`medal ${kind}`} key={`${kind}-${year}`} title={title}>
          <span>{yy(year)}</span>
        </span>
      ))}
    </div>
  );
}

function TeamCard({ row, rows, pairs, seasonMeta, openId, setOpenId, expandAll }) {
  const cardRef = useRef(null);
  const panelRef = useRef(null);
  const open = expandAll || openId === row.teamId;
  const played = row.record.games > 0;

  useEffect(() => {
    if (expandAll && panelRef.current) panelRef.current.style.height = "auto";
  }, [expandAll]);

  const toggle = (e) => {
    if (e.target.closest(".oppcard") || e.target.closest(".scrollwrap") ||
        e.target.closest(".tinfo")) return;
    const card = cardRef.current, panel = panelRef.current;
    const grid = card.parentElement;
    const next = !open;
    const prev = next && openId != null && openId !== row.teamId
      ? grid.querySelector(`[data-team="${openId}"]`) : null;

    flipRow(grid, () => {
      if (prev) {
        prev.classList.remove("expanded");
        setPanelOpen(prev.querySelector(".teamdetail"), false);
      }
      card.classList.toggle("expanded", next);
      setPanelOpen(panel, next);
    }, () => {
      if (next && panel) panel.style.height = "auto";
    });
    setOpenId(next ? row.teamId : null);
  };

  return (
    <div className={`teamcard${open ? " expanded" : ""}`} data-team={row.teamId} ref={cardRef}
      aria-expanded={open ? "true" : "false"} role="button" tabIndex={0} onClick={toggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e); } }}>
      <div className="cardinner">
        <div className="tc-head">
          <TeamLogo src={row.logo} className="lgo" alt="" />
          <div className="tc-name">
            <TeamName row={row} />
            {row.owner ? <em className="cardowner">{row.owner}</em> : null}
          </div>
        </div>
        <div className="tc-mid">
          <div className="tc-pct gradv">{played ? pct(row.record.winPct) : "—"}</div>
          <div className="opp-sub">{played ? "Win rate" : "No games yet"}</div>
          {played && (
            <div className="tc-line">{row.record.wins}-{row.record.losses}-{row.record.ties}</div>
          )}
        </div>
        <MedalTray row={row} seasonMeta={seasonMeta} />
        <span className="chev bottomchev" aria-hidden="true" />
        <div className="teamdetail" ref={panelRef} style={{ height: open ? "auto" : 0 }}>
          <TeamDetail row={row} rows={rows} pairs={pairs} expandAll={expandAll} />
        </div>
      </div>
    </div>
  );
}

/* ================================================================= page */

const HELP_STEPS = [
  [1, "Champions", "One plaque per completed season, newest first. The season being played shows as in progress until a champion is crowned."],
  [2, "League records", "Every all-time superlative and who holds it. Where teams are tied, all of them are listed. Tap the small i on a panel for the detail behind the number."],
  [3, "All-time standings", "Every team that has ever been in the league. Tap any column heading to sort by it; tap again to reverse."],
  [4, "Team records", "Tap a card to open a team's full record, including its head-to-head history against every other team that has ever played here. Tap an opponent to open that series."],
];

export default function HallOfFame() {
  const [theme, setTheme] = useState(() =>
    (typeof document !== "undefined" && document.documentElement.dataset.theme) ||
    (readCookie(THEME_COOKIE) === "light" ? "light" : "dark"));
  const [openId, setOpenId] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [leagueName, setLeagueName] = useState("");

  const expandAll = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("expand") === "1";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  }, [theme]);

  useEffect(() => {
    fetch("/api/meta", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => { if (j && j.leagueName) setLeagueName(j.leagueName); })
      .catch(() => { /* the header simply stays blank */ });
  }, []);

  useEffect(() => {
    // A dev preview injects the payload into the document so the page can be
    // rendered and screenshotted without a session. Browser MCP cannot submit
    // the League Password and does not surface XHR results, so without this
    // hook the tool is unverifiable visually — it only ever shows its loading
    // state. Absent in production, where the fetch below is the only path.
    if (typeof window !== "undefined" && window.__HOF_PREVIEW__) {
      setData(window.__HOF_PREVIEW__);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    fetch("/api/hof", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (!j || j.ok === false) { setError((j && j.error) || "Could not load the record book."); }
        else setData(j);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Could not load the record book.");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const rows = (data && data.rows) || [];
  const pairs = (data && data.pairs) || {};
  const records = (data && data.records) || {};
  const seasonMeta = (data && data.seasonMeta) || {};
  const champions = (data && data.champions) || [];
  const byId = useMemo(() => {
    const m = {};
    for (const r of rows) m[r.teamId] = r;
    return m;
  }, [rows]);

  const ready = Boolean(data && data.ready !== false && rows.length);

  return (
    <div style={{ minHeight: "100svh", fontFamily: UI_FONT }}>
      <div dangerouslySetInnerHTML={{ __html: BACKDROP }} />
      <style>{`
        ${PALETTES}
        ${BASE_CSS}
        html[data-theme="dark"] {
          /* Gold is a site token now; the other two medals are this tool's. */
          --silver:#C8D2D6; --silver-glow:rgba(200,210,214,.24);
          --bronze:#CD8A4D; --bronze-glow:rgba(205,138,77,.24);
        }
        html[data-theme="light"] {
          --silver:#8A97A0; --silver-glow:rgba(138,151,160,.18);
          --bronze:#A85E2A; --bronze-glow:rgba(168,94,42,.18);
        }
        * { box-sizing:border-box; }
        button { -webkit-tap-highlight-color:transparent; font-family:inherit; }
        .wrap { display:flex; flex-direction:column; }

        /* The established tool header, identical to Draft Helper's. */
        .toolhead { display:flex; align-items:center; gap:18px; padding:0 0 14px;
                    border-bottom:1px solid var(--line); }
        .toolmark { flex:none; width:min(46%,340px); }
        .toolmark, .homelink { display:block; text-decoration:none; color:inherit; }
        .toolid { flex:1; min-width:0; text-align:right; }
        .toolid .eyebrow { margin-bottom:4px; justify-content:flex-end; }
        .toolid .eyebrow::after { display:none; }
        .toolleague { font-size:clamp(15px,2.4vw,22px); font-weight:900; letter-spacing:-.02em;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
          background:linear-gradient(96deg,var(--ink) 30%,var(--accent) 130%);
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent; }
        .toolctl { flex:none; display:flex; gap:4px; position:relative; }
        .toolctl .settings { top:38px; }
        @media (max-width:700px) {
          .toolhead { flex-wrap:wrap; gap:10px; }
          .toolmark { width:calc(100% - 74px); }
          .toolid { width:100%; text-align:left; order:3; }
          .toolid .eyebrow { justify-content:flex-start; }
        }
        .toolmark:hover .mark .m2 { fill:var(--accent); }

        /* The full spectrum, compressed to the width of whatever it is painting.
           background-size:100% means the ramp starts and ends at the glyphs'
           own edges, so a four-character value shows the same sweep a long one
           does instead of landing on a single flat colour. */
        /* The ink end holds for the first quarter before it turns, so every
           value visibly travels white to green instead of reading as flat green
           with a pale corner. */
        .gradv { background-image:linear-gradient(100deg, var(--ink) 0%, var(--ink) 24%,
            var(--accent-2) 64%, var(--accent) 100%);
          background-size:100% 100%; background-repeat:no-repeat;
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent;
          display:inline-block; }

        /* Section headers sit in the gap they create: equal air above and
           below, so a title belongs to the space between two sections rather
           than appearing attached to the block beneath it. */
        .sechead { display:flex; align-items:center; justify-content:center; gap:14px;
          margin:clamp(34px,5vw,62px) 0; }
        .sechead::before, .sechead::after { content:""; width:9px; height:9px;
          background:var(--accent); transform:rotate(45deg); flex:none; }
        .sechead .t { font-size:clamp(17px,2.6vw,25px); font-weight:900; letter-spacing:.19em;
          text-transform:uppercase; line-height:1;
          background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent; }
        .stgrouptitle { display:flex; align-items:center; justify-content:center; gap:10px;
          margin:clamp(24px,3.4vw,40px) 0; font-size:clamp(12px,1.5vw,15px); font-weight:900;
          letter-spacing:.17em; text-transform:uppercase; line-height:1; }
        .stgrouptitle span { background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent; }
        .stgrouptitle::before, .stgrouptitle::after { content:""; width:6px; height:6px;
          background:var(--accent); transform:rotate(45deg); flex:none; }

        /* --- scrollbar the pointer owns ------------------------------------ */
        .scrollwrap { position:relative; }
        /* The scroller itself is defined in src/ui.js, shared with the home
           page so both tables behave the same. Only the offsets this tool adds
           on top of it live here. */

        /* --- rows that centre their orphans -------------------------------- */
        .rowgrid { display:flex; flex-wrap:wrap; gap:11px; justify-content:center;
          align-items:stretch; }
        .rowgrid > * { flex:0 0 auto; }

        /* --- one panel anatomy --------------------------------------------- */
        .tile { position:relative; flex:0 0 236px; max-width:236px; min-width:0;
          background:var(--panel-2);
          border:1px solid var(--line); padding:15px 14px; text-align:center;
          display:flex; flex-direction:column; min-height:172px; }
        .tlabel { font-size:10px; font-weight:900; letter-spacing:.1em; text-transform:uppercase;
          color:var(--ink-3); flex:none; padding:0 18px; line-height:1.35; }
        /* Column, not row. As a row the placement line became a sibling beside
           the value, and .tvalue's full width pushed both out of the panel —
           the placement belongs underneath the number it describes. */
        .tbody { flex:1; display:flex; flex-direction:column; align-items:center;
          justify-content:center; padding:8px 0 0; min-width:0; width:100%; }
        .tvalwrap { flex:1; display:flex; align-items:center; justify-content:center;
          width:100%; min-height:0; }
        .tvalue { font-size:clamp(30px,4.6vw,46px); font-weight:900; letter-spacing:-.035em;
          line-height:1; width:100%; font-variant-numeric:tabular-nums; }
        .tvalue.med { font-size:clamp(23px,3.2vw,33px); letter-spacing:-.028em; }
        .tvalue.small { font-size:clamp(17px,2.1vw,22px); letter-spacing:-.015em; line-height:1.15; }
        /* A panel never grows to fit an identity strip. The strip is clipped to the
           panel and tickers instead — most panels will ticker, which is intended. */
        .tfootnames { flex:none; display:flex; justify-content:center; gap:5px;
          min-width:0; max-width:100%; overflow:hidden; }
        .tname { display:flex; align-items:center; gap:5px; font-size:10.5px; font-weight:800;
          color:var(--ink-2); background:var(--inset); border:1px solid var(--line-2);
          padding:2px 7px 2px 2px; max-width:100%; }
        .tname .lgo { width:16px; height:16px; }
        .tname i { font-style:normal; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .tinfo { position:absolute; top:9px; right:9px; width:19px; height:19px; padding:0;
          background:none; border:1px solid var(--line-2); color:var(--ink-3); cursor:pointer;
          display:flex; align-items:center; justify-content:center; border-radius:50%;
          font-size:10px; font-weight:900; line-height:1; z-index:3;
          transition:color .16s ease, border-color .16s ease; }
        .tinfo:hover, .tinfo[aria-expanded="true"] { color:var(--accent); border-color:var(--accent); }
        .tnote { position:absolute; top:32px; right:9px; left:9px; z-index:4;
          background:var(--panel); border:1px solid var(--accent); padding:9px 10px;
          font-size:10.5px; line-height:1.45; color:var(--ink-2); text-align:left;
          box-shadow:0 8px 22px rgba(0,0,0,.34); }

        /* --- tables -------------------------------------------------------- */
        /* The table itself is defined in src/ui.js, so this tool and the home
           page draw the same thing rather than two that drift apart. */
        .inactivetag { font-size:9.5px; color:var(--ink-3); font-weight:700; }
        table.gamelog { font-size:11.5px; }
        .pfchip { font-size:8.5px; font-weight:900; letter-spacing:.06em; text-transform:uppercase;
          color:var(--signal); border:1px solid var(--signal); padding:2px 7px; white-space:nowrap; }
        .wl { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
          font-size:10px; font-weight:900; border:1px solid currentColor; }
        .wl.w { color:var(--accent); } .wl.l { color:var(--flag); }

        /* --- champions: one row, newest first, scrolled not wrapped -------- */
        /* max-content so a long run of seasons scrolls, min-width so a short one
           still fills the frame and can be centred in it. A league three seasons
           old was pinned to the left edge with the rest of the row empty. */
        /* Centred when the seasons fit, scrollable when they do not.
           Plain centre alignment in a scroll container puts the overflow on
           both sides, and the leading edge is then unreachable: the first card,
           which is the season in progress, was clipped with no way to scroll
           back to it. Safe alignment drops to the start the moment it would
           overflow, so the row is centred while it fits and complete when it
           does not. The unprefixed value stays as a fallback for anything that
           does not understand the safe keyword. */
        .champrow { display:flex; gap:12px; padding-bottom:2px;
          width:max-content; min-width:100%;
          justify-content:center; justify-content:safe center; }
        .champcard { flex:0 0 208px; background:var(--panel); border:1px solid var(--line);
          padding:16px 14px; position:relative; text-align:center; display:flex;
          flex-direction:column; min-height:212px; }
        .champcard::before { content:""; position:absolute; left:-1px; right:-1px; top:-1px; height:2px;
          background:linear-gradient(90deg, var(--gold) 0%, transparent 75%); }
        .champyear { font-size:10px; font-weight:900; letter-spacing:.16em; color:var(--ink-3);
          text-transform:uppercase; flex:none; }
        .champbody { flex:1; display:flex; flex-direction:column; align-items:center;
          justify-content:center; padding:10px 0; }
        .champlogo { width:54px; height:54px; margin-bottom:10px; }
        .champname { font-size:clamp(13px,1.4vw,15.5px); font-weight:900; letter-spacing:-.015em;
          line-height:1.15; }
        .champowner { font-size:10.5px; color:var(--ink-2); font-weight:700; flex:none; }
        .chplace { width:100%; padding:14px 8px; }
        .chplace b { font-size:9.5px; }

        /* --- team records -------------------------------------------------- */
        .teamgrid { align-items:flex-start; }
        .teamcard { position:relative; flex:0 0 202px; background:var(--panel);
          border:1px solid var(--line); cursor:pointer; text-align:center; color:inherit;
          font:inherit; transition:border-color .2s ease; overflow:hidden; }
        .teamcard:not(.expanded) { min-height:278px; }
        .teamcard:hover { border-color:var(--accent-deep); }
        .teamcard.expanded { flex:0 0 100%; cursor:default; border-color:var(--accent-deep); }
        .cardinner { padding:18px 16px; display:flex; flex-direction:column; min-height:inherit; }
        .tc-head { flex:none; display:flex; flex-direction:column; align-items:center; gap:9px; }
        .tc-head .lgo { width:50px; height:50px; }
        .tc-name { font-size:clamp(12.5px,1.35vw,14.5px); font-weight:900; letter-spacing:-.015em;
          line-height:1.18; }
        .tc-mid { flex:none; display:flex; flex-direction:column; align-items:center;
          justify-content:center; padding:14px 0 0; }
        .tc-pct { font-size:clamp(30px,3.6vw,40px); font-weight:900; letter-spacing:-.035em;
          line-height:1; font-variant-numeric:tabular-nums; }
        .tc-line { font-size:10px; color:var(--ink-3); font-weight:800; letter-spacing:.1em;
          text-transform:uppercase; margin-top:6px; }
        /* The tray takes the whole remaining column and centres itself in it,
           so medals — or the best-finish line standing in for them — sit
           optically between the record line and the bottom of the card. */
        .tc-badges { flex:1; display:flex; flex-wrap:wrap; justify-content:center;
          align-items:center; align-content:center; gap:7px; min-height:44px; padding:10px 0 2px; }
        .bestfin { font-size:10.5px; font-weight:800; color:var(--ink-3); letter-spacing:.04em;
          line-height:1.3; }
        .bestfin b { display:block; font-weight:900; font-size:12.5px; margin-top:3px;
          background:linear-gradient(104deg, var(--ink) 0%, var(--accent-2) 50%, var(--accent) 100%);
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent; }

        .medal { position:relative; display:flex; align-items:center; justify-content:center;
          width:30px; height:30px; border-radius:50%; font-size:10px; font-weight:900;
          flex:none; letter-spacing:-.02em; }
        /* Struck relief plus a diagonal sheen that sweeps across the face. */
        .medal::after { content:""; position:absolute; inset:0; border-radius:50%;
          box-shadow:inset 0 1px 2px rgba(255,255,255,.62), inset 0 -2px 5px rgba(0,0,0,.34),
            inset 0 0 0 1px rgba(255,255,255,.22);
          background:linear-gradient(115deg, transparent 32%, rgba(255,255,255,.62) 47%,
            transparent 62%);
          background-size:260% 260%; animation:medalsheen 4.6s ease-in-out infinite; }
        @keyframes medalsheen {
          0%,62% { background-position:130% 0; }
          100% { background-position:-40% 0; }
        }
        /* A faint ring that breathes outward, so a tray of medals has depth
           rather than reading as flat dots. */
        .medal > span::after { content:""; position:absolute; inset:-6px; border-radius:50%;
          border:1px solid currentColor; opacity:0; animation:medalring 3.4s ease-out infinite; }
        @keyframes medalring {
          0% { opacity:.5; transform:scale(.82); }
          70%,100% { opacity:0; transform:scale(1.18); }
        }
        .medal > span { position:relative; z-index:1; }
        .medal.gold > span::after { color:var(--gold); }
        .medal.silver > span::after { color:var(--silver); }
        .medal.bronze > span::after { color:var(--bronze); }
        .medal.gold { background:radial-gradient(circle at 34% 28%, #FFF3B0, var(--gold) 62%, #C99A18);
          color:#3A2A00; animation:glowGold 3.4s ease-in-out infinite; }
        .medal.silver { background:radial-gradient(circle at 34% 28%, #FFFFFF, var(--silver) 62%, #8B979B);
          color:#22292B; animation:glowSilver 3.4s ease-in-out infinite .4s; }
        .medal.bronze { background:radial-gradient(circle at 34% 28%, #F0C49A, var(--bronze) 62%, #8E5527);
          color:#2E1806; animation:glowBronze 3.4s ease-in-out infinite .8s; }
        @keyframes glowGold { 0%,100%{box-shadow:0 0 7px 1px var(--gold-glow)} 50%{box-shadow:0 0 15px 4px var(--gold-glow)} }
        @keyframes glowSilver { 0%,100%{box-shadow:0 0 7px 1px var(--silver-glow)} 50%{box-shadow:0 0 15px 4px var(--silver-glow)} }
        @keyframes glowBronze { 0%,100%{box-shadow:0 0 7px 1px var(--bronze-glow)} 50%{box-shadow:0 0 15px 4px var(--bronze-glow)} }
        html.stillness .medal::after,
        html.stillness .medal > span::after,
        html.stillness .medal.gold, html.stillness .medal.silver, html.stillness .medal.bronze {
          animation:none; }

        .teamdetail { overflow:hidden; height:0; }
        .teamdetail-inner { padding-top:2px; margin-top:16px; border-top:1px solid var(--line); }

        .oppcard { position:relative; flex:0 0 186px; background:var(--panel-2);
          border:1px solid var(--line); cursor:pointer; text-align:center; color:inherit;
          font:inherit; overflow:hidden; transition:border-color .2s ease; }
        .oppcard:not(.expanded) { min-height:196px; }
        .oppcard:hover { border-color:var(--accent-deep); }
        .oppcard.expanded { flex:0 0 100%; cursor:default; border-color:var(--accent-deep); }
        .oppinner { padding:14px 12px; display:flex; flex-direction:column; min-height:inherit; }
        .opp-head { flex:none; display:flex; flex-direction:column; align-items:center; gap:7px; }
        .opp-head .lgo { width:32px; height:32px; }
        .opp-name { font-size:11.5px; font-weight:900; line-height:1.15; }
        .opp-mid { flex:1; display:flex; flex-direction:column; align-items:center;
          justify-content:center; padding:10px 0; }
        .opp-pct { font-size:clamp(22px,2.7vw,29px); font-weight:900; letter-spacing:-.035em;
          line-height:1; font-variant-numeric:tabular-nums; }
        .opp-sub { font-size:9px; color:var(--ink-3); font-weight:800; letter-spacing:.12em;
          text-transform:uppercase; margin-top:5px; }
        .opp-foot { flex:none; font-size:10px; color:var(--ink-2); font-weight:800;
          letter-spacing:.08em; min-height:16px; }
        .oppplace { width:100%; padding:12px 6px; }
        .oppplace b { font-size:9px; }
        .oppdetail { overflow:hidden; height:0; }
        .oppdetail-inner { padding-top:2px; margin-top:14px; border-top:1px solid var(--line); }



        /* --- phase selector for tables ------------------------------------- */
        .phasetabs { display:flex; justify-content:center; gap:0; margin:0 0 16px;
          flex-wrap:wrap; }
        /* The selector belongs to the header above it, not the table below. */
        .sechead + .phasetabs { margin-top:calc(-1 * clamp(18px,3vw,34px)); }
        .phasetab { background:var(--panel-2); border:1px solid var(--line-2);
          color:var(--ink-3); font-family:inherit; font-size:9.5px; font-weight:900;
          letter-spacing:.13em; text-transform:uppercase; padding:8px 15px; cursor:pointer;
          margin-left:-1px; transition:color .16s ease, border-color .16s ease,
          background .16s ease; }
        .phasetab:first-child { margin-left:0; }
        .phasetab:hover:not(:disabled) { color:var(--accent); border-color:var(--accent-deep); }
        .phasetab.on { color:var(--field); background:var(--accent); border-color:var(--accent);
          position:relative; z-index:1; }
        .phasetab:disabled { opacity:.4; cursor:not-allowed; }
        /* --- placement beneath a value ------------------------------------- */
        /* A fixed band, centred in the space under the value. Fixed rather than
           natural height so a long "T-2nd (1st: …)" line cannot shove the
           value upward — the value sits at the same height on every panel. */
        .rankline { flex:none; display:flex; align-items:center; justify-content:center;
          height:38px; overflow:hidden; font-size:9.5px; font-weight:800;
          letter-spacing:.04em; color:var(--ink-3); line-height:1.3; padding:0 4px;
          text-align:center; width:100%; }
        .rankline .first { color:var(--gold); font-weight:900; letter-spacing:.12em;
          text-transform:uppercase; font-size:11.5px;
          text-shadow:0 0 10px var(--gold-glow); }
        .ranklead { display:inline; color:var(--ink-3); font-weight:700; }

        /* --- team identity strips ------------------------------------------ */
        .tname i { font-style:normal; display:flex; flex-direction:column; min-width:0;
          align-items:flex-start; line-height:1.2; }
        .tname i b { font-size:10.5px; font-weight:900; white-space:nowrap; }
        .tname i em { font-style:normal; font-size:9px; font-weight:700; color:var(--ink-3);
          white-space:nowrap; margin-top:1px; }
        .tname { padding:3px 8px 3px 3px; align-items:center; }

        /* A strip wider than its panel becomes a ticker rather than wrapping,
           truncating or stacking. Duplicated once and translated by exactly
           half, so the loop has no discoverable seam. */
        .tickerbox { overflow:hidden; position:relative; flex-wrap:nowrap;
          justify-content:center; width:100%; }
        .tickerbox.running { justify-content:flex-start; }
        .tickerbox.running .tickerrow { animation:hofticker 18s linear infinite; }
        .tickerrow { display:flex; gap:5px; flex:none; padding-right:5px; }
        @keyframes hofticker { from { transform:translateX(0); } to { transform:translateX(-100%); } }
        html.stillness .tickerbox.running .tickerrow { animation:none; }

        /* "vs" is a chip of its own, inline with the two it separates. */
        .vsgap { border:0; background:none; color:var(--ink-3); padding:0 2px; }
        .vschip { padding:4px 10px; color:var(--accent); font-size:9px; font-weight:900;
          letter-spacing:.16em; text-transform:uppercase; background:var(--panel);
          border-color:var(--accent-deep); align-self:stretch; align-items:center; }

        /* --- owner name under a card's team name --------------------------- */
        .cardowner { display:block; font-style:normal; font-size:9.5px; font-weight:700;
          color:var(--ink-3); margin-top:3px; letter-spacing:.04em; }

        /* --- the expand affordance, bottom centre --------------------------
           The arrow itself is two borders on an empty box, rotated — the same
           construction every other tool on the site uses, so a chevron here
           reads identically to one in Live Matchups. Without this rule the
           element still positioned and coloured correctly and drew nothing at
           all, which is exactly how it shipped: an invisible affordance on a
           card whose whole interaction depends on looking clickable. */
        .chev { width:9px; height:9px; border-right:2px solid currentColor;
          border-bottom:2px solid currentColor; transform:rotate(45deg);
          transition:transform .2s ease, border-color .2s ease, color .2s ease; }
        .bottomchev { position:absolute; left:50%; bottom:8px; margin-left:-5px;
          width:9px; height:9px; color:var(--accent-deep); opacity:.85; z-index:2; }
        .teamcard:hover .bottomchev, .oppcard:hover .bottomchev { color:var(--accent); opacity:1; }
        [aria-expanded="true"] > .cardinner > .bottomchev,
        [aria-expanded="true"] > .oppinner > .bottomchev { transform:rotate(225deg); }
        .cardinner, .oppinner { position:relative; }
        /* The chevron keeps its own band whether the card is open or shut.
           Reserving it only while collapsed meant an expanded team card ran its
           head-to-head cards straight through its own chevron, so two chevrons
           and a card edge landed on top of each other. Direct children only, so
           an opp card nested inside an open team card cannot inherit it. */
        .teamcard > .cardinner { padding-bottom:26px; }
        .oppcard > .oppinner { padding-bottom:24px; }

        .toolfoot { margin-top:10px; padding:10px 0 4px; text-align:center; border-top:1px solid var(--line); }
        .toolfoot .gh { display:inline-flex; align-items:center; gap:7px; color:var(--ink-3);
          font-size:10px; text-transform:uppercase; letter-spacing:.16em; font-weight:900;
          text-decoration:none; }
        .toolfoot .gh::before { content:""; width:5px; height:5px; background:currentColor; transform:rotate(45deg); }
        .toolfoot .gh:hover { color:var(--accent); }

        /* Never a single column. The basis is a percentage rather than a pixel
           width so it cannot exceed the row and force a wrap to one card per
           line — which is what was still happening at some widths. */
        @media (max-width:860px) {
          .rowgrid { gap:8px; }
          .tile { flex:0 0 calc(50% - 4px); max-width:calc(50% - 4px); min-height:158px; }
          .teamcard:not(.expanded) { flex:0 0 calc(50% - 4px); max-width:calc(50% - 4px); }
          .oppcard:not(.expanded) { flex:0 0 calc(50% - 4px); max-width:calc(50% - 4px); }
          .champcard { flex:0 0 172px; }
          .tvalue { font-size:clamp(22px,6.4vw,32px); }
          .tvalue.med { font-size:clamp(18px,5vw,24px); }
          .tvalue.small { font-size:clamp(14px,3.6vw,18px); }
          .sechead { margin:30px 0; }
        }
        @media (max-width:420px) {
          .tile { min-height:150px; padding:12px 9px; }
          .cardinner { padding:14px 10px; }
          .oppinner { padding:12px 8px; }
        }
      `}</style>

      <div className="wrap">
        <div className="toolhead">
          <a className="toolmark homelink" href="/" aria-label="Back to home">
            <svg className="mark" viewBox="0 0 1000 150" role="img" aria-label="ESPN Fantasy Tools">
              <text className="fit" x="500" y="74" textAnchor="middle" textLength="980"
                lengthAdjust="spacingAndGlyphs" fontSize="86" fontWeight="900" letterSpacing="-2"
                fontFamily={UI_FONT}>
                <tspan className="m1">ESPN</tspan><tspan className="m2"> FANTASY TOOLS</tspan>
              </text>
              <path className="rule" d="M10 100 H990" />
              <path className="rulelive" d="M10 100 H360" />
              <text x="500" y="137" textAnchor="middle" fontSize="30" fontWeight="700"
                letterSpacing="14" fill="var(--ink-3)" fontFamily={UI_FONT}>LEAGUE HQ</text>
            </svg>
          </a>
          <div className="toolid">
            <p className="eyebrow">Hall of Fame</p>
            <div className="toolleague">{leagueName}</div>
          </div>
          <div className="toolctl">
            <ToolControls steps={HELP_STEPS} label="How to use the Hall of Fame" theme={theme} onTheme={setTheme} />
          </div>
        </div>

        {error && <div className="msg err" style={{ display: "block" }}>{error}</div>}

        {loading && !data ? (
          <>
            <SecHead>Champions</SecHead>
            <Placeholder title="Loading the record book" note="Reading every season this league has played." />
          </>
        ) : !ready ? (
          <>
            <SecHead>Champions</SecHead>
            <Placeholder title="No league history yet"
              note="Once a season has been played, the record book fills itself in." />
            <SecHead>League Records</SecHead>
            <Placeholder title="No records yet" note="Records appear once a season has been played." />
            <SecHead>All-Time Standings</SecHead>
            <Placeholder title="No seasons completed yet"
              note="Standings populate once games have been played." />
            <SecHead>Team Records</SecHead>
            <Placeholder title="No teams have played yet"
              note="This league's roster hasn't started a season." />
          </>
        ) : (
          <>
            <Champions champions={champions} byId={byId} />
            <LeagueRecords records={records} byId={byId} />
            <Standings rows={rows} seasonMeta={seasonMeta} />
            <SecHead>Team Records</SecHead>
            <div className="rowgrid teamgrid">
              {rows.map((row) => (
                <TeamCard key={row.teamId} row={row} rows={rows} pairs={pairs}
                  seasonMeta={seasonMeta} openId={openId} setOpenId={setOpenId}
                  expandAll={expandAll} />
              ))}
            </div>
          </>
        )}

        <div className="grow" />
        <div className="pageaction">
          <a className="pagebtn" href="/">&larr; Back to home</a>
        </div>
        <div className="toolfoot">
          <a className="gh" href="https://github.com/shortcutsbin-netizen" target="_blank" rel="noopener noreferrer">
            GitHub - shortcutsbin-netizen
          </a>
        </div>
      </div>

    </div>
  );
}
