import ToolControls from "../shared/ToolControls.jsx";
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { PALETTES, BASE_CSS, BACKDROP } from "../../src/ui.js";
import SettingsMenu from "../shared/SettingsMenu.jsx";
import TeamLogo from "../shared/TeamLogo.jsx";
import { weightDays, makeXOf } from "./axis.js";
import Instructions from "../shared/Instructions.jsx";

/**
 * Live Matchups.
 *
 * Every number on this page comes from `/api/live/week`, which serves the
 * reduced `live_scoring_digest` rather than the raw ESPN payload — the source is
 * hundreds of kilobytes and this polls every fifteen seconds. The score
 * progression charts read `/api/live/timeline`, which is the one thing on the
 * site backed by a Cron Trigger: a chart's value is the record of what was true
 * when nobody was watching, and that cannot be reconstructed after the fact.
 *
 * Chrome is the tool's own rather than shell()'s, exactly like Draft Helper —
 * same tokens, same wordmark sizing, its own composition.
 */

const UI_FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const TEAM_COOKIE = "eft_team";
const THEME_COOKIE = "eft_theme";
const IDLE_LIMIT_MS = 4 * 60 * 60 * 1000;

/** Expand and collapse at a constant speed rather than a constant duration. */
const DISCLOSURE_RATE = 0.7; // px per ms
const EASE = "cubic-bezier(.3,.85,.35,1)";

const CHART_W = 600, CHART_H = 150;
// A weekday abbreviation at 9px is about this wide in the chart's own
// coordinate space. Used to decide whether a label would be clipped.
const LABEL_W = 20, LABEL_PAD = 4;

// ---------------------------------------------------------------- small utils

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const m = new RegExp("(?:^|; )" + name + "=([^;]*)").exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : "";
}

/**
 * The zone chosen in Site settings.
 *
 * The shell exposes window.siteTz on server-rendered pages, but a tool bundle
 * is served from its own minimal shell with no shared script, so the cookie is
 * read directly here with the same fallback ui.js uses. Preferring the global
 * when it exists keeps a single source of truth if that ever changes.
 */
function readSiteTz() {
  if (typeof window !== "undefined" && typeof window.siteTz === "function") {
    return window.siteTz();
  }
  const chosen = readCookie("eft_tz");
  if (chosen) return chosen;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

const n1 = (v) => (Number(v) || 0).toFixed(1);
const initials = (name) => String(name || "").split(" ")
  .filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const shortName = (name) => {
  const parts = String(name || "").split(" ").filter(Boolean);
  if (parts.length < 2) return name || "";
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
};

function useIdleClock() {
  const [idle, setIdle] = useState(false);
  const lastActive = useRef(Date.now());
  useEffect(() => {
    const bump = () => { lastActive.current = Date.now(); setIdle(false); };
    const events = ["pointerdown", "keydown", "scroll", "touchstart", "focus"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => setIdle(Date.now() - lastActive.current > IDLE_LIMIT_MS), 60000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(t);
    };
  }, []);
  return idle;
}

// ---------------------------------------------------------------- data

/**
 * One week of matchups.
 *
 * Only the current week polls. A completed week is immutable — the server has
 * already stored it permanently — so re-requesting it would be pure cost.
 */
function useWeek(week, idle) {
  const [state, setState] = useState({ data: null, error: null, at: null, loading: true });
  const timer = useRef(null);

  const load = useCallback(async (quiet) => {
    try {
      /* The dev preview inlines a real payload into the document, because the
         browser tool used to inspect this page cannot sign in and never sees an
         XHR result. Same hook the Hall of Fame uses, and inert without it. */
      if (typeof window !== "undefined" && window.__LM_PREVIEW__) {
        // A preview payload that says it is not ready is shown as such, the
        // same way a live one would be, rather than as an empty week.
        const seeded = window.__LM_PREVIEW__;
        setState(seeded && seeded.ok === false
          ? { data: null, error: seeded.error || 'Could not load this week.', at: null, loading: false }
          : { data: seeded, error: null, at: new Date(), loading: false });
        return;
      }
      if (!quiet) setState((s) => ({ ...s, loading: true }));
      const q = week ? `?w=${week}` : "";
      const res = await fetch(`/api/live/week${q}`, { credentials: "same-origin" });
      if (res.status === 401) {
        setState({ data: null, error: "Your session expired. Reload to sign in again.", at: null, loading: false });
        return;
      }
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `${res.status}`);
      setState({ data: body, error: null, at: new Date(), loading: false });
    } catch (e) {
      setState((s) => ({ ...s, error: e.message || "Could not load this week.", loading: false }));
    }
  }, [week]);

  useEffect(() => {
    load(false);
    return undefined;
  }, [load]);

  const isCurrent = state.data ? state.data.live : true;
  useEffect(() => {
    if (!isCurrent) return undefined;
    function tick() {
      if (!document.hidden && !idle) load(true);
      timer.current = setTimeout(tick, 15000);
    }
    timer.current = setTimeout(tick, 15000);
    const onVisible = () => { if (!document.hidden && !idle) load(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, idle, isCurrent]);

  return { ...state, reload: () => load(true) };
}

/** All-time meetings. Only changes when the historical pull runs. */
function useH2h() {
  const [h2h, setH2h] = useState(null);
  useEffect(() => {
    let live = true;
    if (typeof window !== "undefined" && window.__LM_H2H_PREVIEW__) {
      setH2h(window.__LM_H2H_PREVIEW__);
      return () => { live = false; };
    }
    fetch("/api/live/h2h", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((b) => { if (live) setH2h(b); })
      .catch(() => { if (live) setH2h({ ok: true, ready: false, pairs: {} }); });
    return () => { live = false; };
  }, []);
  return h2h;
}

/** The stored score history for a week. Written by the cron, never by a view. */
function useTimeline(season, week, live, idle) {
  const [rows, setRows] = useState([]);
  const [lastTick, setLastTick] = useState(null);
  const [events, setEvents] = useState([]);
  const load = useCallback(async () => {
    if (!season || !week) return;
    /* Inlined for the dev preview, same as the week and head-to-head payloads.
       Without it the progression charts read as empty in preview while the
       stored timeline held dozens of rows — a preview that disagrees with the
       page it previews. */
    if (typeof window !== "undefined" && window.__LM_TIMELINE_PREVIEW__) {
      const pv = window.__LM_TIMELINE_PREVIEW__;
      setRows(Array.isArray(pv.rows) ? pv.rows : []);
      setLastTick(pv.lastTick || null);
      setEvents(Array.isArray(pv.events) ? pv.events : []);
      return;
    }
    try {
      const res = await fetch(`/api/live/timeline?season=${season}&w=${week}`,
        { credentials: "same-origin" });
      const body = await res.json();
      setRows(Array.isArray(body.rows) ? body.rows : []);
      setLastTick(body.lastTick || null);
      setEvents(Array.isArray(body.events) ? body.events : []);
    } catch { /* the charts and feed fall back to their empty states */ }
  }, [season, week]);

  // Diagnostics: what the component actually holds, as opposed to what the
  // preview inlined. The two disagreeing is the whole reason this exists.
  useEffect(() => {
    if (typeof window !== "undefined" && window.__LM_TIMELINE_PREVIEW__) {
      window.__LM_SEEN__ = { rows: rows.length, events: events.length,
        season: season || null, week: week || null };
    }
  }, [rows, events, season, week]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => { if (!document.hidden && !idle) load(); }, 60000);
    return () => clearInterval(t);
  }, [load, live, idle]);
  return { rows, events, lastTick };
}

// ---------------------------------------------------------------- chart maths

/*
 * The day axis.
 *
 * Every full calendar day inside the frame gets identical pixel width, and a
 * partial day at either end gets a proportionally smaller share of that same
 * per-day width. The frame is cropped to the real data at both ends: it starts
 * at the first stored tick, not at midnight before it, so a Thursday night
 * kickoff does not leave most of a day's width empty.
 */
function localYMD(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-US",
    { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ts));
  const o = {};
  parts.forEach((p) => { o[p.type] = p.value; });
  return `${o.year}-${o.month}-${o.day}`;
}
function weekdayOf(ts, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ts));
}
function nextMidnightAfter(ts, tz) {
  const day0 = localYMD(ts, tz);
  let lo = ts, hi = ts + 26 * 3600000;
  while (localYMD(hi, tz) === day0) hi += 24 * 3600000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (localYMD(mid, tz) === day0) lo = mid; else hi = mid;
  }
  return hi;
}
function localMidnightOf(ts, tz) {
  const day0 = localYMD(ts, tz);
  let lo = ts - 26 * 3600000, hi = ts;
  while (localYMD(lo, tz) === day0) lo -= 24 * 3600000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (localYMD(mid, tz) === day0) hi = mid; else lo = mid;
  }
  return hi;
}

function buildDaySpan(axisStart, axisEnd, tz) {
  const days = [];
  let cursor = axisStart;
  let guard = 0;
  while (cursor < axisEnd && guard++ < 40) {
    const dayStart = localMidnightOf(cursor, tz);
    const dayEnd = nextMidnightAfter(cursor, tz);
    // The true length of this local day, so a DST change does not silently
    // widen or narrow one segment relative to the others.
    const fullDur = dayEnd - dayStart;
    const segEnd = Math.min(dayEnd, axisEnd);
    days.push({
      start: cursor, fullDur, segEnd,
      frac: (segEnd - cursor) / fullDur,
      label: weekdayOf(cursor, tz),
    });
    cursor = dayEnd;
  }
  return days;
}

const yOf = (v, min, max, padTop, innerH) =>
  padTop + innerH - ((v - min) / ((max - min) || 1)) * innerH;

/* Longer than this between two samples and nothing was being recorded.
   The cron samples every minute inside a game window, so anything beyond a few
   minutes is a gap rather than a slow tick. */
const SAMPLE_GAP_MS = 10 * 60 * 1000;

/* Expand a series so a recording gap reads as a hold rather than a slope.
 *
 * A straight line between two samples a day apart reads as points being scored
 * all night: the Thursday game ends, nothing is recorded until Sunday, and the
 * chart draws a smooth climb through Friday and Saturday that never happened.
 * A score cannot drift while nobody is playing, so the honest shape is flat
 * until the next sample and then a step.
 *
 * Every chart in this section goes through here. The margin chart used to build
 * its own path inline and kept sloping through gaps after the others had been
 * fixed, which is the whole argument for one implementation.
 */
function seriesPoints(values, times) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i > 0 && times[i] - times[i - 1] > SAMPLE_GAP_MS) {
      out.push([times[i], values[i - 1]]);
    }
    out.push([times[i], values[i]]);
  }
  return out;
}

function linePath(values, times, xOf, min, max, padTop, padBottom) {
  const innerH = CHART_H - padTop - padBottom;
  return seriesPoints(values, times)
    .map(([t, v], i) => (i === 0 ? "M" : "L") +
      xOf(t).toFixed(1) + "," + yOf(v, min, max, padTop, innerH).toFixed(1))
    .join(" ");
}

function DayAxis({ days }) {
  const out = [];
  let cumX = 0;
  days.forEach((d, i) => {
    const segW = d.w;
    if (i > 0) {
      out.push(<line key={`m${i}`} className="daymark" x1={cumX.toFixed(1)} y1="0"
        x2={cumX.toFixed(1)} y2={CHART_H} />);
    }
    // A label that would be clipped — by the next day's marker or by the right
    // edge of the frame — is not drawn at all. A half-rendered weekday reads as
    // a rendering fault rather than as information.
    const fits = segW >= LABEL_W + LABEL_PAD && cumX + LABEL_PAD + LABEL_W <= CHART_W;
    if (fits) {
      out.push(<text key={`t${i}`} className="chartlabel" x={(cumX + LABEL_PAD).toFixed(1)}
        y={CHART_H - 5} textAnchor="start">{d.label}</text>);
    }
    cumX += segW;
  });
  return <>{out}</>;
}

function GridLines({ padTop, padBottom, n }) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const y = padTop + (CHART_H - padTop - padBottom) * (i / n);
    out.push(<line key={i} className="chartgrid" x1="0" y1={y.toFixed(1)} x2={CHART_W} y2={y.toFixed(1)} />);
  }
  return <>{out}</>;
}

let clipSeq = 0;
function Diverging({ values, times, xOf, min, max, baseline, padTop, padBottom }) {
  const ids = useMemo(() => { clipSeq += 1; return { top: `ct${clipSeq}`, bot: `cb${clipSeq}` }; }, []);
  const innerH = CHART_H - padTop - padBottom;
  const baseY = yOf(baseline, min, max, padTop, innerH);
  const pts = seriesPoints(values, times)
    .map(([t, v]) => [xOf(t), yOf(v, min, max, padTop, innerH)]);
  const d = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const areaD = `M${pts[0][0].toFixed(1)},${baseY.toFixed(1)} ` +
    pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") +
    ` L${pts[pts.length - 1][0].toFixed(1)},${baseY.toFixed(1)} Z`;
  return (
    <>
      <defs>
        <clipPath id={ids.top}><rect x="0" y="0" width={CHART_W} height={baseY.toFixed(1)} /></clipPath>
        <clipPath id={ids.bot}><rect x="0" y={baseY.toFixed(1)} width={CHART_W} height={(CHART_H - baseY).toFixed(1)} /></clipPath>
      </defs>
      <line className="chartaxis" x1="0" y1={baseY.toFixed(1)} x2={CHART_W} y2={baseY.toFixed(1)} />
      <path d={areaD} fill="var(--accent)" fillOpacity="0.16" clipPath={`url(#${ids.top})`} />
      <path d={areaD} fill="var(--sky)" fillOpacity="0.16" clipPath={`url(#${ids.bot})`} />
      <path className="chartpath" d={d} stroke="var(--accent)" clipPath={`url(#${ids.top})`} />
      <path className="chartpath" d={d} stroke="var(--sky)" clipPath={`url(#${ids.bot})`} />
    </>
  );
}

function ChartSlot({ name, children, empty }) {
  return (
    <div className="chartblock">
      <span className="chartname">{name}</span>
      {empty
        ? <div className="placeholder"><b>Nothing recorded yet</b><span>{empty}</span></div>
        : children}
    </div>
  );
}

function Progression({ series, tz, homeName, awayName, kickoff }) {
  const frame = useMemo(() => {
    if (!series || series.times.length < 2) return null;
    const times = series.times;
    // Cropped to the real data at both ends.
    const span = buildDaySpan(times[0], times[times.length - 1], tz);
    if (!span.length) return null;
    /* One frame for the whole section.
       The three charts describe the same matchup over the same minutes, so
       reading them together only works if a vertical position means the same
       instant in all of them. They share this object rather than each deriving
       its own, which is what keeps them aligned by construction. */
    const days = weightDays(span, times, CHART_W);
    return { days, xOf: makeXOf(days) };
  }, [series, tz]);

  // Each chart states its own absence rather than the section swallowing all
  // three behind one message, so it stays obvious which of them is waiting.
  if (!frame) {
    const why = kickoff
      ? "The score history starts at the first kickoff of this matchup."
      : "This matchup has no scheduled games yet.";
    return (
      <>
        <ChartSlot name="Total score" empty={why} />
        <ChartSlot name="Margin" empty={why} />
        <ChartSlot name="Win probability" empty={why} />
      </>
    );
  }

  const { days, xOf } = frame;
  const { times, home, away, wp } = series;
  const padTop = 8, padBottom = 20;
  const scoreMax = Math.max(...home, ...away, 1) * 1.08;
  const margin = home.map((v, i) => v - away[i]);
  const maxAbsM = Math.max(...margin.map(Math.abs)) * 1.25 || 1;
  const hasWp = wp.some((v) => v !== null && v !== undefined);
  const maxDevWP = hasWp ? (Math.max(...wp.map((v) => Math.abs((v ?? 50) - 50))) * 1.2 || 5) : 5;

  return (
    <>
      <div className="chartblock">
        <span className="chartname">Total score</span>
        <svg className="progchart" viewBox={`0 0 ${CHART_W} ${CHART_H}`}>
          <GridLines padTop={padTop} padBottom={padBottom} n={3} />
          <path className="chartpath" style={{ stroke: "var(--accent)" }}
            d={linePath(home, times, xOf, 0, scoreMax, padTop, padBottom)} />
          <path className="chartpath" style={{ stroke: "var(--sky)" }}
            d={linePath(away, times, xOf, 0, scoreMax, padTop, padBottom)} />
          <DayAxis days={days} />
        </svg>
      </div>
      <div className="chartblock">
        <span className="chartname">Margin</span>
        <svg className="progchart" viewBox={`0 0 ${CHART_W} ${CHART_H}`}>
          <GridLines padTop={padTop} padBottom={padBottom} n={4} />
          <Diverging values={margin} times={times} xOf={xOf} min={-maxAbsM} max={maxAbsM}
            baseline={0} padTop={padTop} padBottom={padBottom} />
          <DayAxis days={days} />
        </svg>
      </div>
      {!hasWp && (
        <ChartSlot name="Win probability"
          empty="No win probability was recorded for this matchup." />
      )}
      {hasWp && (
        <div className="chartblock">
          <span className="chartname">Win probability</span>
          <svg className="progchart" viewBox={`0 0 ${CHART_W} ${CHART_H}`}>
            <GridLines padTop={padTop} padBottom={padBottom} n={4} />
            <Diverging values={wp.map((v) => v ?? 50)} times={times} xOf={xOf}
              min={50 - maxDevWP} max={50 + maxDevWP} baseline={50}
              padTop={padTop} padBottom={padBottom} />
            <DayAxis days={days} />
          </svg>
        </div>
      )}
      <div className="legend">
        <span><i style={{ background: "var(--accent)" }} /> {homeName}</span>
        <span><i style={{ background: "var(--sky)" }} /> {awayName}</span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- disclosure

/**
 * Fixed-rate expand and collapse.
 *
 * Panels differ enormously in height, and a single transition duration makes a
 * short one crawl and a tall one snap. Driving the Web Animations API at a
 * constant pixels-per-millisecond gives every panel the same apparent speed.
 *
 * Two details matter and both were real bugs first. After opening, the height
 * is released to `auto`, so a nested panel opening inside this one has
 * somewhere to expand into rather than being silently clipped by a height
 * measured before it existed. Before closing, the height is re-measured rather
 * than reused, since that nested growth means the cached value is stale.
 */
function Disclosure({ label, children, defaultOpen = false, className = "dsection" }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelRef = useRef(null);
  const innerRef = useRef(null);
  const animRef = useRef(null);

  const toggle = useCallback(() => {
    const panel = panelRef.current, inner = innerRef.current;
    if (!panel || !inner) { setOpen((o) => !o); return; }
    if (animRef.current) { animRef.current.cancel(); animRef.current = null; }

    if (!open) {
      const target = inner.offsetHeight;
      const dur = Math.max(140, Math.min(900, target / DISCLOSURE_RATE));
      const anim = panel.animate(
        [{ height: "0px" }, { height: `${target}px` }],
        { duration: dur, easing: EASE }
      );
      anim.onfinish = () => { panel.style.height = "auto"; animRef.current = null; };
      animRef.current = anim;
      panel.style.height = `${target}px`;
      setOpen(true);
    } else {
      const current = panel.getBoundingClientRect().height;
      const dur = Math.max(140, Math.min(900, current / DISCLOSURE_RATE));
      const anim = panel.animate(
        [{ height: `${current}px` }, { height: "0px" }],
        { duration: dur, easing: EASE }
      );
      anim.onfinish = () => { animRef.current = null; };
      animRef.current = anim;
      panel.style.height = "0px";
      setOpen(false);
    }
  }, [open]);

  return (
    <div className={className}>
      <button className="subtoggle" aria-expanded={open} onClick={toggle} type="button">
        <span className="panelhead"><span className="t">{label}</span></span>
        <i className="chev" />
      </button>
      <div className="subbody" ref={panelRef} style={{ height: open ? "auto" : 0 }}>
        <div className={`subbody-inner reveal-stagger${open ? " opened" : ""}`} ref={innerRef}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sections

function Highlights({ g }) {
  const cell = (label, value, colour) => (
    <div className="hlcell">
      <span className="hlft">{label}</span>
      <span className="hlv" style={colour ? { color: colour } : undefined}>{value}</span>
    </div>
  );
  const side = (s) => [
    cell("Top scorer", s.top ? `${shortName(s.top.name)} ${n1(s.top.points)}` : "—"),
    cell("Bottom scorer", s.bottom ? `${shortName(s.bottom.name)} ${n1(s.bottom.points)}` : "—"),
    cell("Avg / starter", n1(s.avgPerStarter)),
    cell("Bench points", n1(s.benchPoints)),
  ];
  const h = side(g.home), a = side(g.away);
  return (
    <div className="hlgridouter">
      <div className="hlteamname">{g.home.name}</div>
      <div className="hlteamname">{g.away.name}</div>
      {h[0]}{h[1]}{a[0]}{a[1]}
      {h[2]}{h[3]}{a[2]}{a[3]}
    </div>
  );
}

const INJ_LETTER = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O", INJURY_RESERVE: "IR", SUSPENSION: "S" };

function Lineups({ g, tz }) {
  const rows = Math.max(g.home.starters.length, g.away.starters.length);
  // Before kickoff a row shows when that player's own NFL game starts, in the
  // zone chosen in Site settings. Every row previously formatted the same
  // missing value, which rendered the epoch as one shared time for everybody.
  const meta = (p) => {
    if (!p) return "";
    if (p.gameStatus === "pre") {
      if (!p.kickoff) return p.nfl;
      try {
        const d = new Date(p.kickoff);
        return `${p.nfl} · ` + d.toLocaleString(undefined,
          { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
      } catch { return p.nfl; }
    }
    return p.gameState ? `${p.nfl} · ${p.gameState}` : p.nfl;
  };
  const out = [];
  for (let i = 0; i < rows; i++) {
    const hp = g.home.starters[i], ap = g.away.starters[i];
    out.push(
      <tr key={i}>
        <td className="pcellL">
          <span className="pname">{hp ? shortName(hp.name) : "—"}
            {hp && hp.injury ? <i className="injbadge">{INJ_LETTER[hp.injury] || "!"}</i> : null}</span>
          <span className="pmeta">{meta(hp)}</span>
        </td>
        <td className="dotcell">{hp ? <span className={`godot ${hp.gameStatus === "live" ? "live" : hp.gameStatus === "final" ? "fin" : "up"}`} /> : null}</td>
        <td className="ptscell home">{hp ? <><b>{n1(hp.points)}</b><small>{n1(hp.proj)}</small></> : null}</td>
        <td className="poscell">{(hp && hp.slot) || (ap && ap.slot) || ""}</td>
        <td className="ptscell away">{ap ? <><b>{n1(ap.points)}</b><small>{n1(ap.proj)}</small></> : null}</td>
        <td className="dotcell">{ap ? <span className={`godot ${ap.gameStatus === "live" ? "live" : ap.gameStatus === "final" ? "fin" : "up"}`} /> : null}</td>
        <td className="pcellR">
          <span className="pname">{ap ? shortName(ap.name) : "—"}
            {ap && ap.injury ? <i className="injbadge">{INJ_LETTER[ap.injury] || "!"}</i> : null}</span>
          <span className="pmeta">{meta(ap)}</span>
        </td>
      </tr>
    );
  }
  const bench = (s) => (
    <details>
      <summary>
        {s.name} bench · {n1(s.benchPoints)} unused (proj {n1(s.benchProjected)})
      </summary>
      {s.bench.map((p) => (
        <div className="benchrow" key={p.id}>
          <span>{shortName(p.name)} <small>{p.pos}</small></span>
          <span className="benchpts"><b>{n1(p.points)}</b><small>{n1(p.proj)}</small></span>
        </div>
      ))}
    </details>
  );
  return (
    <>
      <table className="lineup">
        <colgroup><col /><col className="dotcol" /><col className="ptscol" /><col className="poscol" /><col className="ptscol" /><col className="dotcol" /><col /></colgroup>
        <tbody>{out}</tbody>
      </table>
      <div className="lineuplegend">
        <div className="leggroup">
          <span><i className="godot live" /> Live</span>
          <span><i className="godot fin" /> Final</span>
          <span><i className="godot up" /> Upcoming</span>
        </div>
        <div className="leggroup">
          <span><i className="injbadge">Q</i> Questionable</span>
          <span><i className="injbadge">D</i> Doubtful</span>
          <span><i className="injbadge">O</i> Out</span>
        </div>
      </div>
      <div className="benchwrap">{bench(g.home)}{bench(g.away)}</div>
    </>
  );
}

const POS_ORDER = ["QB", "RB", "WR", "TE", "FLX", "D/K", "BN"];

function PositionBreakdown({ g }) {
  const labels = POS_ORDER.filter((k) => g.home.byPos[k] !== undefined || g.away.byPos[k] !== undefined);
  const row = (label, hv, av, total) => {
    const peak = Math.max(Math.abs(hv), Math.abs(av)) || 1;
    return (
      <div className={`posrow${total ? " total" : ""}`} key={label}>
        <div className="posbar home"><i style={{ width: `${Math.round((Math.abs(hv) / peak) * 100)}%` }} /></div>
        <span className="posval">{n1(hv)}</span>
        <span className="poslabel">{label}</span>
        <span className="posval">{n1(av)}</span>
        <div className="posbar away"><i style={{ width: `${Math.round((Math.abs(av) / peak) * 100)}%` }} /></div>
      </div>
    );
  };
  return (
    <>
      {labels.map((k) => row(k, g.home.byPos[k] || 0, g.away.byPos[k] || 0, false))}
      {row("SUM", g.home.byPos.SUM || 0, g.away.byPos.SUM || 0, true)}
      <div className="legend">
        <span><i style={{ background: "var(--accent)" }} /> {g.home.name}</span>
        <span><i style={{ background: "var(--sky)" }} /> {g.away.name}</span>
      </div>
    </>
  );
}

const GAUGE_R = 42, GAUGE_CIRC = 2 * Math.PI * GAUGE_R;

function Gauge({ side, kind, active }) {
  const pct = side.optimal > 0 ? Math.min(1, side.points / side.optimal) : 0;
  const [shown, setShown] = useState(0);
  const gradId = `grad-${kind}-${side.teamId}`;

  useEffect(() => {
    if (!active) { setShown(0); return undefined; }
    let raf = 0;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 900);
      setShown(pct * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active, pct]);

  const angle = shown * 2 * Math.PI;
  return (
    <div className={`gauge ${kind}`}>
      <div className="gaugelabel">{side.name}</div>
      <div className="gaugewrap">
        <svg viewBox="0 0 100 100">
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={kind === "home" ? "var(--accent-deep)" : "var(--sky)"} />
              <stop offset="100%" stopColor={kind === "home" ? "var(--accent-2)" : "#8fc4ff"} />
            </linearGradient>
          </defs>
          <circle className="gaugeframe" cx="50" cy="50" r="45.5" />
          <circle className="gaugetrack" cx="50" cy="50" r={GAUGE_R} />
          <g className="gaugeticks">
            <line x1="92" y1="50" x2="96.5" y2="50" /><line x1="50" y1="92" x2="50" y2="96.5" />
            <line x1="8" y1="50" x2="3.5" y2="50" /><line x1="50" y1="8" x2="50" y2="3.5" />
          </g>
          <circle className="gaugeframe" cx="50" cy="50" r="38.5" />
          <circle className="gaugeval" cx="50" cy="50" r={GAUGE_R} stroke={`url(#${gradId})`}
            style={{ strokeDashoffset: GAUGE_CIRC * (1 - shown) }} />
          <circle className="gaugedot" r="3.2"
            cx={50 + GAUGE_R * Math.cos(angle)} cy={50 + GAUGE_R * Math.sin(angle)} />
        </svg>
        <div className="gaugecenter"><b>{n1(side.points)}</b><small>of {n1(side.optimal)}</small></div>
      </div>
    </div>
  );
}

function SwingTable({ rows, positive }) {
  if (!rows.length) return null;
  return (
    <div style={positive ? undefined : { marginTop: 18 }}>
      <span className={`chartname${positive ? "" : " bust"}`}
        style={{ color: positive ? "var(--accent)" : "var(--flag)" }}>{positive ? "Boom" : "Bust"}</span>
      <table className="plaintable">
        <thead><tr><th>Player</th><th>Team</th><th className="num">Actual</th><th className="num">Proj</th><th className="num">&Delta;%</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.id}-${p.team}`}>
              <td>{shortName(p.name)}</td><td>{p.team}</td>
              <td className="num">{n1(p.points)}</td><td className="num">{n1(p.proj)}</td>
              <td className="num" style={{ color: positive ? "var(--accent)" : "var(--flag)" }}>
                {positive ? "+" : "\u2212"}{Math.abs(p.delta)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeasonContext({ g }) {
  const mini = (s) => (
    <div className="seasonmini">
      <div className="seasonteam">{s.name}</div>
      <div className="rec">{s.record || "—"}</div>
      <div className="pf">{s.seed ? `${s.seed} seed · ` : ""}{n1(s.pointsFor)} PF / {n1(s.pointsAgainst)} PA</div>
      {s.streak ? (
        <div className="formstrip">
          <i className={s.streak[0] === "W" ? "w" : "l"}>{s.streak[0]}</i>
          <span className="nextopp" style={{ marginTop: 0, marginLeft: 6 }}>{s.streak}</span>
        </div>
      ) : null}
    </div>
  );
  return <div className="seasoncols">{mini(g.home)}{mini(g.away)}</div>;
}

function NflGame({ game, tz }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null), innerRef = useRef(null), animRef = useRef(null);
  const toggle = () => {
    const panel = panelRef.current, inner = innerRef.current;
    if (!panel || !inner) { setOpen((o) => !o); return; }
    if (animRef.current) animRef.current.cancel();
    if (!open) {
      const target = inner.offsetHeight;
      const a = panel.animate([{ height: "0px" }, { height: `${target}px` }],
        { duration: Math.max(140, Math.min(900, target / DISCLOSURE_RATE)), easing: EASE });
      a.onfinish = () => { panel.style.height = "auto"; animRef.current = null; };
      animRef.current = a; panel.style.height = `${target}px`; setOpen(true);
    } else {
      const current = panel.getBoundingClientRect().height;
      const a = panel.animate([{ height: `${current}px` }, { height: "0px" }],
        { duration: Math.max(140, Math.min(900, current / DISCLOSURE_RATE)), easing: EASE });
      a.onfinish = () => { animRef.current = null; };
      animRef.current = a; panel.style.height = "0px"; setOpen(false);
    }
  };
  const label = game.status === "pre"
    ? (() => {
        try {
          return new Date(game.kickoff).toLocaleTimeString(undefined,
            { timeZone: tz, hour: "numeric", minute: "2-digit" });
        } catch { return "Upcoming"; }
      })()
    : game.state;
  const pct = game.status === "final" ? 100 : game.status === "live" ? 55 : 0;
  return (
    <div className="nflgame" data-state={game.status}>
      <button className="nflgtoggle" aria-expanded={open} onClick={toggle} type="button">
        <div className="nflgtop">
          <span className="nflteams">{game.away} @ {game.home}</span>
          <span className="nflscoreclock">
            <span className="nflscore">
              {game.awayScore !== null && game.awayScore !== undefined
                ? `${game.awayScore}\u2013${game.homeScore}` : "\u2013"}
            </span>
            <i className="chev" />
          </span>
        </div>
        <div className="nflprogress-row">
          <span className="nflstate">{label}</span>
          <div className="nflprogress"><i style={{ width: `${pct}%` }} /></div>
        </div>
      </button>
      <div className="nflgbody" ref={panelRef} style={{ height: open ? "auto" : 0 }}>
        <div className={`nflgbody-inner reveal-stagger${open ? " opened" : ""}`} ref={innerRef}>
          <div className="nflplayers">
            {game.players.map((p, i) => (
              <div className="nflplayer" key={i}>
                <div className="nflavatar">{initials(p.name)}</div>
                <div className="nflpname">{shortName(p.name)}</div>
                <div className="nflpts">{n1(p.points)}</div>
                <div className="nflproj">proj {n1(p.proj)}</div>
                <div className={`nflteamtag ${p.side}`}>{p.team}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function HeadToHead({ g, h2h }) {
  if (!h2h || !h2h.ready) {
    return (
      <div className="placeholder">
        <b>No history yet</b>
        <span>Past seasons have not been pulled. Run the historical pull from Site Configuration.</span>
      </div>
    );
  }
  const a = g.home.teamId, b = g.away.teamId;
  const low = Math.min(a, b), high = Math.max(a, b);
  const rec = h2h.pairs[`${low}:${high}`];
  if (!rec || !rec.games.length) {
    return (
      <div className="placeholder">
        <b>First meeting</b>
        <span>These two have not played each other in any season on record.</span>
      </div>
    );
  }
  // Everything is stored low-id-first; flip it once here rather than at every
  // point of use.
  const homeIsLow = a === low;
  const homeWins = homeIsLow ? rec.lowWins : rec.highWins;
  const awayWins = homeIsLow ? rec.highWins : rec.lowWins;
  const homePts = homeIsLow ? rec.lowPoints : rec.highPoints;
  const awayPts = homeIsLow ? rec.highPoints : rec.lowPoints;
  const played = rec.games.length;

  return (
    <>
      <div className="h2hhead">
        <div className="h2hside">
          <span className="h2hteam">{g.home.name}</span>
          <span className="h2hbig">{homeWins}</span>
        </div>
        <div className="h2hmid">
          <span>{played} meeting{played === 1 ? "" : "s"}</span>
          {rec.ties ? <span>{rec.ties} tie{rec.ties === 1 ? "" : "s"}</span> : null}
          <span>{n1(homePts)} &ndash; {n1(awayPts)} pts</span>
        </div>
        <div className="h2hside away">
          <span className="h2hteam">{g.away.name}</span>
          <span className="h2hbig">{awayWins}</span>
        </div>
      </div>
      <table className="plaintable">
        <thead><tr><th>Season</th><th>Wk</th>
          <th className="num">{g.home.abbrev || "Home"}</th>
          <th className="num">{g.away.abbrev || "Away"}</th></tr></thead>
        <tbody>
          {rec.games.slice(0, 10).map((m, i) => {
            const hp = homeIsLow ? m.lowPts : m.highPts;
            const ap = homeIsLow ? m.highPts : m.lowPts;
            return (
              <tr key={i}>
                <td>{m.season}{m.playoff ? " · PO" : ""}</td>
                <td>{m.week || "—"}</td>
                <td className="num" style={hp > ap ? { color: "var(--accent)" } : undefined}>{n1(hp)}</td>
                <td className="num" style={ap > hp ? { color: "var(--sky)" } : undefined}>{n1(ap)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function ScoringFeed({ g, events, tz }) {
  const mine = useMemo(() => {
    const byId = {};
    for (const side of [g.home, g.away]) {
      for (const p of side.starters) byId[String(p.id)] = { ...p, team: side.name, side };
    }
    return (events || [])
      .filter((e) => String(e.m) === String(g.id) && byId[String(e.p)])
      .map((e) => ({ ...e, player: byId[String(e.p)] }))
      .sort((x, y) => String(y.t).localeCompare(String(x.t)))
      .slice(0, 40);
  }, [events, g]);

  if (!mine.length) {
    return (
      <div className="placeholder">
        <b>Nothing scored yet</b>
        <span>Every point either lineup scores appears here as it happens.</span>
      </div>
    );
  }
  const clock = (iso) => {
    try {
      return new Date(iso).toLocaleTimeString(undefined,
        { timeZone: tz, hour: "numeric", minute: "2-digit" });
    } catch { return ""; }
  };
  return (
    <div className="feed">
      {mine.map((e, i) => (
        <div className={`feedrow ${e.player.side === g.home ? "home" : "away"}`} key={i}>
          <span className="feedtime">{clock(e.t)}</span>
          <span className="feedname">{shortName(e.player.name)}
            <small>{e.player.pos} · {e.player.nfl}</small></span>
          <span className="feeddelta">{e.d > 0 ? "+" : "\u2212"}{n1(Math.abs(e.d))}</span>
          <span className="feedtotal">{n1(e.v)}</span>
        </div>
      ))}
    </div>
  );
}

function Unwired({ title, why }) {
  return <div className="placeholder"><b>{title}</b><span>{why}</span></div>;
}

// ---------------------------------------------------------------- match card

function MatchCard({ g, tz, timelineRows, lastTick, events, h2h, pinned, expandAll }) {
  const [open, setOpen] = useState(expandAll);
  const panelRef = useRef(null), innerRef = useRef(null), animRef = useRef(null);

  const toggle = () => {
    const panel = panelRef.current, inner = innerRef.current;
    if (!panel || !inner) { setOpen((o) => !o); return; }
    if (animRef.current) animRef.current.cancel();
    if (!open) {
      const target = inner.offsetHeight;
      const a = panel.animate([{ height: "0px" }, { height: `${target}px` }],
        { duration: Math.max(140, Math.min(1100, target / DISCLOSURE_RATE)), easing: EASE });
      // Released to auto so the nested subsections below have room to grow into
      // rather than being clipped by a height measured before they opened.
      a.onfinish = () => { panel.style.height = "auto"; animRef.current = null; };
      animRef.current = a; panel.style.height = `${target}px`; setOpen(true);
    } else {
      const current = panel.getBoundingClientRect().height;
      const a = panel.animate([{ height: `${current}px` }, { height: "0px" }],
        { duration: Math.max(140, Math.min(1100, current / DISCLOSURE_RATE)), easing: EASE });
      a.onfinish = () => { animRef.current = null; };
      animRef.current = a; panel.style.height = "0px"; setOpen(false);
    }
  };

  /*
   * Rows only count once the matchup has actually started.
   *
   * ESPN posts a win probability for a fixture the moment the week exists, so
   * an ungated chart draws a flat line across the days before anyone played and
   * presents it as history. The frame therefore opens at the first kickoff
   * across either starting lineup — the point at which the numbers begin to
   * mean something — and before that instant there is no chart at all.
   */
  const series = useMemo(() => {
    const from = g.firstKickoff ? Date.parse(g.firstKickoff) : null;
    if (!from || !Number.isFinite(from) || Date.now() < from) return null;
    const times = [], home = [], away = [], wp = [];
    for (const r of timelineRows || []) {
      const v = r.m && r.m[g.id];
      if (!v) continue;
      const t = Date.parse(r.t);
      if (!Number.isFinite(t) || t < from) continue;
      times.push(t); home.push(Number(v[0]) || 0); away.push(Number(v[1]) || 0);
      wp.push(v[2] === null || v[2] === undefined ? null : Number(v[2]));
    }
    /* Carry the last known values out to the most recent sample.
     *
     * Repeats are no longer stored, so a matchup whose players have all
     * finished has its final point at the moment it last moved. Without this
     * the line would stop partway across a chart whose axis runs to now, which
     * reads as missing data rather than as a score that has stopped changing.
     * The added point is the last one repeated, so it draws as the flat line it
     * describes. */
    if (times.length && lastTick) {
      const end = Date.parse(lastTick);
      if (Number.isFinite(end) && end > times[times.length - 1]) {
        times.push(end);
        home.push(home[home.length - 1]);
        away.push(away[away.length - 1]);
        wp.push(wp[wp.length - 1]);
      }
    }
    return times.length >= 2 ? { times, home, away, wp } : null;
  }, [timelineRows, lastTick, g.id, g.firstKickoff]);

  const final = g.state === "final";
  const homeWins = final && (g.winner === "HOME" || (!g.winner && g.home.points > g.away.points));
  const awayWins = final && (g.winner === "AWAY" || (!g.winner && g.away.points > g.home.points));
  const marginNow = g.home.points - g.away.points;
  const marginProj = g.home.projected - g.away.projected;
  const leader = marginNow >= 0 ? g.home : g.away;
  const projLeader = marginProj >= 0 ? g.home : g.away;

  // The logo when the team has one, the shield when it does not. Never an
  // invented code: an abbreviation the league never chose reads as real data in
  // exactly the way placeholder identity does.
  const logoBox = (s) => <TeamLogo src={s.logo} className="mlogo" />;

  const teamBlock = (s, sideKey, wins, loses) => (
    <div className={`mteam ${sideKey}${wins ? " winner" : ""}${loses ? " loser" : ""}`}>
      {sideKey === "away" ? null : logoBox(s)}
      <div className="mteam-info">
        <div className="mname">{s.name}</div>
        <div className="mownerfull">{s.owner}</div>
        <div className="mrecline">{[s.record, s.streak].filter(Boolean).join(" · ")}</div>
      </div>
      {sideKey === "away" ? logoBox(s) : null}
    </div>
  );

  const hasWp = g.home.winProb !== null && g.away.winProb !== null;

  return (
    <article className="mcard" data-state={g.state} data-pinned={pinned ? "1" : undefined}>
      <div className="mcard-top">
        {teamBlock(g.home, "home", homeWins, awayWins)}
        <span className="mvs">{g.state === "live" ? "Live" : g.state === "final" ? "Final" : "vs"}</span>
        {teamBlock(g.away, "away", awayWins, homeWins)}
      </div>

      {hasWp && (
        <>
          <div className="wprow">
            <span className="wppct home">{Math.round(g.home.winProb)}%</span>
            <div className="wpbar">
              <div className="wpfill home" style={{ width: `${g.home.winProb}%` }} />
              <div className="wpseam" style={{ left: `${g.home.winProb}%` }} />
              <div className="wpfill away" style={{ width: `${g.away.winProb}%` }} />
            </div>
            <span className="wppct away">{Math.round(g.away.winProb)}%</span>
          </div>
          <div className="wpcaption">Win probability</div>
        </>
      )}

      <div className="mscores">
        <div className="mscore home"><b>{n1(g.home.points)}</b><small>proj {n1(g.home.projected)}</small></div>
        <div className="mmargin">
          {g.state === "pre" ? (
            <span>{projLeader.name} +{n1(Math.abs(marginProj))} proj</span>
          ) : (
            <span>
              <span className={`marrow ${marginNow >= 0 ? "home" : "away"}`}>&#9650;</span>{" "}
              {leader.name} +{n1(Math.abs(marginNow))} now<br />
              {projLeader.name} +{n1(Math.abs(marginProj))} proj
            </span>
          )}
        </div>
        <div className="mscore away"><b>{n1(g.away.points)}</b><small>proj {n1(g.away.projected)}</small></div>
      </div>

      {g.state !== "pre" && (
        <div className="mstatus">
          <div className="statuscol home">
            {g.home.counts.live ? <span className="statuschip live">{g.home.counts.live} live</span> : null}
            {g.home.counts.upcoming ? <span className="statuschip">{g.home.counts.upcoming} upcoming</span> : null}
            {g.home.counts.final ? <span className="statuschip fin">{g.home.counts.final} final</span> : null}
          </div>
          <div className="statuscol away">
            {g.away.counts.live ? <span className="statuschip live">{g.away.counts.live} live</span> : null}
            {g.away.counts.upcoming ? <span className="statuschip">{g.away.counts.upcoming} upcoming</span> : null}
            {g.away.counts.final ? <span className="statuschip fin">{g.away.counts.final} final</span> : null}
          </div>
        </div>
      )}

      {final && (
        <div className="finalstrip">
          <span className="finalbadge">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12.5 9.5 18 20 6.5" />
            </svg>
            Final
          </span>
          <span className="finaltext">
            {(homeWins ? g.home.name : g.away.name)} wins by {n1(Math.abs(marginNow))}
          </span>
        </div>
      )}

      {g.playoff && <div className="narrativechip">Playoff matchup</div>}

      <button className="mexpand" aria-expanded={open} onClick={toggle} type="button">
        Full breakdown <i className="chev" />
      </button>

      <div className="mdetail" ref={panelRef} style={{ height: open ? "auto" : 0 }}>
        <div className={`mdetail-inner reveal-stagger${open ? " opened" : ""}`} ref={innerRef}>
          <Disclosure defaultOpen={expandAll} label="Highlights">
            {g.state === "pre"
              ? <Unwired title="Nothing scored yet" why="Highlights appear once the first game kicks off." />
              : <Highlights g={g} />}
          </Disclosure>

          <Disclosure defaultOpen={expandAll} label="Lineups"><Lineups g={g} tz={tz} /></Disclosure>

          <Disclosure defaultOpen={expandAll} label="Score progression">
            <Progression series={series} tz={tz} kickoff={g.firstKickoff}
              homeName={g.home.name} awayName={g.away.name} />
          </Disclosure>

          <Disclosure defaultOpen={expandAll} label="Position breakdown">
            {g.state === "pre"
              ? <Unwired title="No points yet" why="The breakdown compares what each position has actually scored." />
              : <PositionBreakdown g={g} />}
          </Disclosure>

          <Disclosure defaultOpen={expandAll} label="Optimal lineup">
            {g.state === "pre"
              ? <Unwired title="Nothing to second-guess yet" why="This compares the lineup started against the best one available, once points exist." />
              : <OptimalPair g={g} />}
          </Disclosure>

          <Disclosure defaultOpen={expandAll} label="Boom / bust">
            {g.boom.length || g.bust.length
              ? <><SwingTable rows={g.boom} positive /><SwingTable rows={g.bust} positive={false} /></>
              : <Unwired title="No swings yet" why="Boom and bust compare each player against their own projection." />}
          </Disclosure>

          <Disclosure defaultOpen={expandAll} label="Head-to-head">
            <HeadToHead g={g} h2h={h2h} />
          </Disclosure>

          <Disclosure defaultOpen={expandAll} label="Season context"><SeasonContext g={g} /></Disclosure>

          {/* Not "in play": this lists every fixture either lineup has a player
              in, which on a Thursday is mostly games three days away. The
              section's own empty state already said "involves either lineup",
              so the label was the part that was wrong. */}
          <Disclosure defaultOpen={expandAll} label="NFL games">
            {g.nflGames.length
              ? g.nflGames.map((ng) => <NflGame key={ng.key} game={ng} tz={tz} />)
              : <Unwired title="No games scheduled" why="No NFL fixture on this week's board involves either lineup." />}
          </Disclosure>

          <Disclosure defaultOpen={expandAll} label="Scoring feed">
            <ScoringFeed g={g} events={events} tz={tz} />
          </Disclosure>
        </div>
      </div>
    </article>
  );
}

function OptimalPair({ g }) {
  const [active, setActive] = useState(false);
  useEffect(() => { const t = setTimeout(() => setActive(true), 60); return () => clearTimeout(t); }, []);
  return (
    <div className="gaugerow">
      <Gauge side={g.home} kind="home" active={active} />
      <Gauge side={g.away} kind="away" active={active} />
    </div>
  );
}

// ---------------------------------------------------------------- shell

const HELP_STEPS = [
  ["01", "Your matchup first", "Whichever team you picked on the dashboard is sorted to the top. The choice is shared with every other tool."],
  ["02", "Read the bar", "The split bar is ESPN's own win chance, not a calculation of ours. It moves as the games do."],
  ["03", "Open a breakdown", "Full breakdown opens both lineups, scoring by position, the week's booms and busts, the NFL games your players are in, and your record against that opponent."],
  ["04", "Watch the shape", "Score and win chance are recorded every minute all week, so you can see where a matchup turned even if you missed it. Quiet stretches are squeezed up so the games fill the chart."],
  ["05", "Look back", "The arrows either side of the week walk back through weeks already played, with their final scores and their charts."],
];

export default function LiveMatchups() {
  const idle = useIdleClock();
  const [theme, setTheme] = useState(() =>
    (typeof document !== "undefined" && document.documentElement.dataset.theme) ||
    (readCookie(THEME_COOKIE) === "light" ? "light" : "dark"));
  const [tz, setTz] = useState(() => readSiteTz());
  const [week, setWeek] = useState(0); // 0 = whatever the server calls current

  /* Opens every card and every subsection at once. Its first use is
     verification — a headless browser cannot click, so without it the whole
     expanded half of this tool could only ever be inspected by hand — but it is
     equally the way to read a whole week in one scroll. */
  const expandAll = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("expand") === "1";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  }, [theme]);

  // The zone can change in Site settings while this page is open.
  useEffect(() => {
    const onTz = () => setTz(readSiteTz());
    window.addEventListener("tzchange", onTz);
    return () => window.removeEventListener("tzchange", onTz);
  }, []);

  const [leagueName, setLeagueName] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/meta", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((m) => { if (live && m && m.leagueName) setLeagueName(m.leagueName); })
      .catch(() => { /* the header simply carries no league name */ });
    return () => { live = false; };
  }, []);

  const { data, error, at, loading } = useWeek(week, idle);
  const digest = data ? data.digest : null;
  const currentWeek = data ? data.current : 0;
  const shownWeek = data ? data.week : 0;
  const isCurrent = data ? data.live : true;
  const { rows: timelineRows, events, lastTick } = useTimeline(
    digest && digest.season, shownWeek, isCurrent, idle);
  const h2h = useH2h();

  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const myTeam = useMemo(() => Number(readCookie(TEAM_COOKIE)) || null, []);
  const games = useMemo(() => {
    const list = [...((digest && digest.games) || [])];
    if (!myTeam) return list;
    const mine = (g) => (g.home.teamId === myTeam || g.away.teamId === myTeam ? 0 : 1);
    return list.sort((a, b) => mine(a) - mine(b));
  }, [digest, myTeam]);

  const agoLabel = (() => {
    if (!at) return "loading…";
    const secs = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
    if (secs < 60) return `Updated ${secs}s ago`;
    const mins = Math.round(secs / 60);
    return `Updated ${mins}m ago`;
  })();

  return (
    <div style={{ minHeight: "100svh", fontFamily: UI_FONT }}>
      <div dangerouslySetInnerHTML={{ __html: BACKDROP }} />
      <style>{`
        ${PALETTES}
        ${BASE_CSS}
        * { box-sizing:border-box; }
        button { -webkit-tap-highlight-color:transparent; font-family:inherit; }
        .wrap { display:flex; flex-direction:column; }

        /* The established tool header, identical to Draft Helper's: wordmark
           left, tool name and league right, controls in their own cluster. */
        .toolhead { display:flex; align-items:center; gap:18px; padding:0 0 14px;
                    border-bottom:1px solid var(--line); margin-bottom:18px; }
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

        /* The selector and the freshness note share one line: the note is a
           label for the selector's state, not a separate row of furniture. */
        .weekbar { display:flex; align-items:center; justify-content:space-between;
          gap:12px; flex-wrap:nowrap; margin:16px 0 18px; }
        .weeksel { display:flex; align-items:center; gap:8px; flex:none; }
        .weekbtn { background:none; border:1px solid var(--line-2); color:var(--ink-2);
          width:28px; height:28px; cursor:pointer; font-size:14px; font-weight:900;
          display:flex; align-items:center; justify-content:center;
          transition:border-color .16s ease, color .16s ease; }
        .weekbtn:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
        .weekbtn:disabled { opacity:.3; cursor:default; }
        .weeklabel { font-size:13px; font-weight:900; letter-spacing:.02em; min-width:64px; text-align:center; }
        .updated { font-size:10.5px; font-weight:800; color:var(--ink-3); letter-spacing:.06em;
          display:flex; align-items:center; gap:7px; margin-left:auto; text-align:right;
          min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .updated i { width:6px; height:6px; border-radius:50%; background:var(--accent);
          animation:blip 1.8s ease-in-out infinite; flex:none; }
        @keyframes blip { 0%,100%{opacity:1} 50%{opacity:.3} }

        .matchlist { display:flex; flex-direction:column; gap:14px; }
        .mcard { position:relative; background:var(--panel); border:1px solid var(--line);
          padding:16px clamp(14px,1.6vw,20px); }
        .mcard::before { content:""; position:absolute; left:-1px; right:-1px; top:-1px; height:2px;
          background:linear-gradient(90deg, var(--line-2) 0%, transparent 60%); }
        .mcard[data-state="live"]::before { background:linear-gradient(90deg, var(--accent) 0%, var(--accent-deep) 34%, transparent 78%); }
        .mcard[data-state="final"]::before { background:linear-gradient(90deg, var(--ink-3) 0%, transparent 60%); }
        /* Your own matchup is sorted to the top. Saying so is the point: a card
           silently reordered above the others is just an unexplained ordering. */
        .mcard[data-pinned]::after { content:"Your matchup"; position:absolute;
          top:-1px; right:-1px; font-size:8px; font-weight:900; letter-spacing:.12em;
          text-transform:uppercase; color:var(--field); background:var(--accent);
          padding:3px 8px; }
        .mcard-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
        .mteam { display:flex; align-items:center; gap:10px; flex:1; min-width:0; }
        .mteam.away { justify-content:flex-end; text-align:right; }
        .mlogo { flex:none; width:44px; height:44px;
          background:var(--inset); border:1px solid var(--line-2); }
        .mteam-info { display:flex; flex-direction:column; gap:1px; min-width:0; }
        /* A team's name is never shortened: the line wraps and the block grows
           rather than ending in an ellipsis nobody can read. */
        .mname { font-size:13.5px; font-weight:900; letter-spacing:-.01em;
          overflow-wrap:anywhere; }
        .mownerfull { font-size:10px; color:var(--ink-2); font-weight:700;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .mrecline { font-size:9.5px; color:var(--ink-3); font-weight:700; letter-spacing:.03em; }
        .mvs { flex:none; font-size:9.5px; font-weight:900; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); }

        .wprow { position:relative; display:flex; align-items:center; gap:9px; margin-top:14px; }
        .wppct { flex:none; font-size:13.5px; font-weight:900; font-variant-numeric:tabular-nums; width:38px; }
        .wppct.home { color:var(--accent); text-align:left; }
        .wppct.away { color:var(--sky); text-align:right; }
        .wpbar { position:relative; flex:1; display:flex; height:11px; border:1px solid var(--line-2);
          overflow:hidden; box-shadow:inset 0 1px 3px rgba(0,0,0,.35); background:var(--inset); }
        .wpfill { position:relative; height:100%; transition:width 1.1s cubic-bezier(.2,.8,.2,1); overflow:hidden; }
        .wpfill.home { background:linear-gradient(90deg, var(--accent-deep), var(--accent)); }
        .wpfill.away { background:linear-gradient(90deg, var(--sky), #3d84d6); }
        .wpfill::after { content:""; position:absolute; inset:0;
          background-image:repeating-linear-gradient(115deg, rgba(255,255,255,.16) 0 3px, transparent 3px 9px); }
        .wpseam { position:absolute; top:-3px; bottom:-3px; width:2px; background:var(--field);
          box-shadow:0 0 8px 1px var(--accent-glow); z-index:2; transition:left 1.1s cubic-bezier(.2,.8,.2,1); }
        .wpcaption { text-align:center; font-size:8.5px; font-weight:900; letter-spacing:.14em;
          text-transform:uppercase; color:var(--ink-3); margin-top:5px; }

        /* The scores are the point of this row, so they are sized to their own
           content and the margin note takes whatever is left.
           It used to be the other way around — an auto centre column against
           1fr scores — so a long team name in the note squeezed the numbers
           until they clipped mid-glyph: "70.5" rendered as "70.!". Names are
           unbounded and scores are four characters, so the fixed thing should
           be the scores. */
        .mscores { display:grid; grid-template-columns:auto minmax(0,1fr) auto;
          align-items:center; gap:10px; margin-top:14px; }
        .mscore { text-align:center; flex:none; }
        .mscore.home { text-align:left; }
        .mscore.away { text-align:right; }
        .mscore b { font-size:clamp(26px,5vw,32px); font-weight:900; letter-spacing:-.02em;
          font-variant-numeric:tabular-nums; display:block; line-height:1;
          background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent; }
        .mscore small { font-size:10.5px; color:var(--ink-3); font-weight:700; }
        /* Wraps rather than pushing the scores aside. A long pair of team names
           takes as many lines as it needs; the numbers never move. */
        .mmargin { font-size:10.5px; color:var(--ink-2); font-weight:800; text-align:center;
          display:flex; align-items:center; justify-content:center; gap:5px;
          min-width:0; overflow-wrap:anywhere; }
        .marrow { color:var(--accent); font-size:12px; }
        .marrow.away { color:var(--sky); }

        .mstatus { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:14px; }
        .statuscol { display:flex; flex-direction:column; gap:5px; }
        .statuscol.home { align-items:flex-start; }
        .statuscol.away { align-items:flex-end; }
        .statuschip { font-size:9.5px; font-weight:900; letter-spacing:.08em; text-transform:uppercase;
          padding:4px 8px; border:1px solid var(--line-2); color:var(--ink-3); }
        .statuschip.live { color:var(--accent); border-color:var(--accent); }
        .statuschip.live::before { content:"● "; }

        .narrativechip { font-size:11.5px; color:var(--ink-2); background:var(--inset);
          border-left:2px solid var(--accent); padding:9px 11px; margin-top:12px; }

        .finalstrip { display:flex; align-items:center; justify-content:center; gap:10px;
          margin-top:14px; padding:11px; background:var(--accent-glow); border:1px solid var(--accent);
          animation:finalglow 2.4s ease-in-out infinite; }
        @keyframes finalglow {
          0%,100% { box-shadow:0 0 0 0 var(--accent-glow); }
          50% { box-shadow:0 0 14px 3px var(--accent-glow); }
        }
        .finalbadge { display:flex; align-items:center; gap:5px; font-size:9.5px; font-weight:900;
          letter-spacing:.1em; text-transform:uppercase; color:var(--accent); flex:none; }
        .finalbadge svg { width:12px; height:12px; stroke:var(--accent); fill:none; }
        .finaltext { font-size:13px; font-weight:900; color:var(--ink); }
        .mteam.winner .mlogo { border-color:var(--gold);
          box-shadow:0 0 10px 2px var(--gold-glow); animation:goldpulse 2.6s ease-in-out infinite; }
        .mteam.winner .mname { color:var(--gold); -webkit-text-fill-color:var(--gold); }
        @keyframes goldpulse {
          0%,100% { box-shadow:0 0 10px 2px var(--gold-glow); }
          50% { box-shadow:0 0 18px 5px var(--gold-glow); }
        }
        .mteam.loser { opacity:.55; }

        .mexpand { width:100%; margin-top:14px; background:none; border:1px solid var(--line-2);
          color:var(--ink-2); font-size:10.5px; font-weight:900;
          letter-spacing:.14em; text-transform:uppercase; padding:11px; cursor:pointer;
          display:flex; align-items:center; justify-content:center; gap:8px;
          transition:border-color .16s ease, color .16s ease; }
        .mexpand:hover { border-color:var(--accent); color:var(--accent); }
        .chev { width:8px; height:8px; border-right:2px solid currentColor; border-bottom:2px solid currentColor;
          transform:rotate(45deg); transition:transform .3s ease; flex:none; }
        [aria-expanded="true"] .chev { transform:rotate(225deg); }

        .mdetail { overflow:hidden; }
        .mdetail-inner { padding-top:18px; }
        .dsection { border-top:1px solid var(--line); margin-top:12px; }
        .dsection:first-child { border-top:0; margin-top:0; }
        .subtoggle { width:100%; background:none; border:0; padding:14px 0; margin:0; cursor:pointer;
          display:flex; align-items:center; justify-content:space-between; text-align:left; }
        .subtoggle .chev { color:var(--ink-3); }
        .subtoggle[aria-expanded="true"] .chev { color:var(--accent); }
        .subbody { overflow:hidden; }
        .subbody-inner { padding-bottom:18px; }
        .panelhead { display:flex; align-items:center; gap:10px; margin:0; }

        .reveal-stagger > * { opacity:0; transform:translateY(6px);
          transition:opacity .38s ease, transform .38s ease; }
        .reveal-stagger.opened > * { opacity:1; transform:none; }
        .reveal-stagger.opened > *:nth-child(1){transition-delay:.02s}
        .reveal-stagger.opened > *:nth-child(2){transition-delay:.07s}
        .reveal-stagger.opened > *:nth-child(3){transition-delay:.12s}
        .reveal-stagger.opened > *:nth-child(4){transition-delay:.17s}
        .reveal-stagger.opened > *:nth-child(n+5){transition-delay:.2s}

        .hlgridouter { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:8px; }
        .hlteamname { grid-column:span 2; text-align:center; font-size:11px; font-weight:900;
          letter-spacing:.08em; text-transform:uppercase; color:var(--ink-2); padding-bottom:6px;
          overflow-wrap:anywhere; }
        .hlcell { background:var(--inset); border:1px solid var(--line); padding:11px 6px;
          text-align:center; display:flex; flex-direction:column; align-items:center;
          justify-content:center; gap:4px; min-width:0; }
        .hlft { font-size:8.5px; font-weight:900; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); }
        .hlv { font-size:11.5px; font-weight:800; font-variant-numeric:tabular-nums;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }

        table.lineup { width:100%; table-layout:fixed; border-collapse:collapse; font-size:10px; }
        table.lineup col.ptscol { width:36px; }
        table.lineup col.dotcol { width:12px; }
        table.lineup col.poscol { width:30px; }
        table.lineup td { padding:6px 2px; border-bottom:1px solid var(--line); vertical-align:middle; min-width:0; }
        table.lineup .pcellL { text-align:left; }
        table.lineup .pcellR { text-align:right; }
        table.lineup .pname { display:block; font-weight:800; font-size:10px; white-space:nowrap;
          overflow:hidden; text-overflow:ellipsis; }
        table.lineup .pmeta { display:block; font-size:8px; color:var(--ink-3); white-space:nowrap;
          overflow:hidden; text-overflow:ellipsis; }
        table.lineup .dotcell { text-align:center; }
        .godot { width:6px; height:6px; border-radius:50%; display:inline-block; }
        .godot.live { background:var(--accent); box-shadow:0 0 0 2px var(--accent-glow); }
        .godot.fin { background:var(--ink-3); }
        .godot.up { background:transparent; border:1px solid var(--line-2); }
        .injbadge { display:inline-block; font-size:7.5px; font-weight:900; color:var(--signal);
          background:var(--signal-soft); padding:1px 3px; margin-left:3px; font-style:normal; }
        table.lineup .ptscell { font-variant-numeric:tabular-nums; }
        table.lineup .ptscell.home { text-align:right; }
        table.lineup .ptscell.away { text-align:left; }
        table.lineup .ptscell b { display:block; font-size:10.5px; }
        table.lineup .ptscell small { display:block; font-size:7.5px; color:var(--ink-3); }
        table.lineup .poscell { text-align:center; font-size:8px; font-weight:900; color:var(--ink-3); }

        .lineuplegend { display:flex; flex-direction:column; gap:9px; margin-top:14px;
          padding-top:12px; border-top:1px solid var(--line); }
        .leggroup { display:flex; flex-wrap:wrap; gap:12px; }
        .leggroup span { display:flex; align-items:center; gap:5px; font-size:9.5px;
          color:var(--ink-3); font-weight:700; white-space:nowrap; }
        .leggroup .injbadge { margin-left:0; }

        .benchwrap { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:14px; }
        .benchwrap > details { min-width:0; font-size:11px; }
        .benchwrap summary { cursor:pointer; font-weight:800; color:var(--ink-2);
          list-style:none; display:flex; align-items:center; gap:6px; }
        .benchwrap summary::-webkit-details-marker { display:none; }
        .benchwrap summary::before { content:"+"; color:var(--accent); font-weight:900; width:10px; flex:none; }
        .benchwrap details[open] summary::before { content:"\\2212"; }
        .benchwrap .benchrow { display:flex; justify-content:space-between; gap:6px;
          padding:6px 0; border-bottom:1px solid var(--line); color:var(--ink-2); font-size:10.5px; }
        .benchwrap .benchrow small { color:var(--ink-3); }
        /* Points over projection, the same stack the starting lineup uses, so a
           bench row reads the same way a starter's does. */
        .benchwrap .benchrow .benchpts { flex:none; text-align:right;
          font-variant-numeric:tabular-nums; }
        .benchwrap .benchrow .benchpts b { display:block; font-size:10.5px; color:var(--ink-2); }
        .benchwrap .benchrow .benchpts small { display:block; font-size:8px; color:var(--ink-3); }

        .chartblock + .chartblock { margin-top:24px; }
        .chartname { font-size:10.5px; font-weight:900; letter-spacing:.06em; text-transform:uppercase;
          color:var(--ink-2); margin-bottom:6px; display:inline-block; position:relative; padding-bottom:4px; }
        .chartname::after { content:""; position:absolute; left:0; bottom:0; width:22px; height:2px;
          background:linear-gradient(90deg,var(--accent),transparent); }
        .chartname.bust::after { background:linear-gradient(90deg,var(--flag),transparent); }
        .chartblock .chartname { display:block; text-align:center; padding-bottom:0; }
        .chartblock .chartname::after { display:none; }
        /* Aspect-ratio locked to the viewBox, so the SVG's own uniform scaling
           handles every width at every moment. Nothing measures the container,
           so there is no measurement to go stale on a resize. */
        .progchart { width:100%; aspect-ratio:600/150; height:auto; display:block;
          filter:drop-shadow(0 0 6px var(--accent-glow)); }
        .chartpath { fill:none; stroke-width:2.5; }
        .chartaxis { stroke:var(--line); stroke-width:1; }
        .chartgrid { stroke:var(--line); stroke-width:1; opacity:.5; }
        .daymark { stroke:var(--line-2); stroke-width:1; stroke-dasharray:2 3; }
        .chartlabel { font-size:9px; fill:var(--ink-3); font-weight:700; }
        .legend { display:flex; justify-content:center; gap:20px; margin-top:16px; padding-top:12px;
          border-top:1px solid var(--line); flex-wrap:wrap; }
        .legend span { font-size:10.5px; font-weight:800; display:flex; align-items:center; gap:6px; color:var(--ink-2); }
        .legend i { width:12px; height:3px; display:block; border-radius:2px; }

        .posrow { display:grid; grid-template-columns:1fr 34px 34px 34px 1fr; align-items:center; gap:6px; margin-bottom:11px; }
        .posrow.total { border-top:1px solid var(--line); padding-top:11px; margin-top:2px; }
        .posrow.total .posval { font-weight:900; }
        .posbar { height:9px; border:1px solid var(--line); background:var(--inset); overflow:hidden;
          box-shadow:inset 0 1px 3px rgba(0,0,0,.3); min-width:0; }
        .posbar.home { display:flex; justify-content:flex-end; }
        .posbar i { display:block; height:100%; transition:width .8s cubic-bezier(.2,.8,.2,1); }
        .posbar.home i { background:linear-gradient(270deg, var(--accent), var(--accent-deep)); }
        .posbar.away i { background:linear-gradient(90deg, var(--sky), #3d84d6); }
        .posval { font-size:11px; font-weight:800; font-variant-numeric:tabular-nums; text-align:center; }
        .poslabel { font-size:9px; font-weight:900; color:var(--ink-3); text-align:center; }

        .gaugerow { display:flex; gap:24px; justify-content:center; margin-top:4px; }
        .gauge { flex:1; max-width:170px; text-align:center; min-width:0; }
        /* The gauge sizes to its label rather than cutting a team's name. */
        .gaugelabel { font-size:10.5px; font-weight:900; letter-spacing:.08em; text-transform:uppercase;
          color:var(--ink-2); margin-bottom:8px; overflow-wrap:anywhere; }
        .gaugewrap { position:relative; filter:drop-shadow(0 3px 8px rgba(0,0,0,.35)); }
        .gaugewrap svg { width:100%; height:auto; transform:rotate(-90deg); display:block; overflow:visible; }
        .gaugeframe { fill:none; stroke:var(--accent-deep); stroke-width:.6; opacity:.55; }
        .gaugetrack { fill:none; stroke:var(--line); stroke-width:8; }
        .gaugeticks line { stroke:var(--line-2); stroke-width:1.5; }
        .gaugeval { fill:none; stroke-width:8; stroke-linecap:round; stroke-dasharray:263.9; }
        .gaugedot { stroke:none; }
        .gauge.home .gaugedot { fill:var(--accent-2); filter:drop-shadow(0 0 4px var(--accent)); }
        .gauge.away .gaugedot { fill:#8fc4ff; filter:drop-shadow(0 0 4px var(--sky)); }
        .gaugecenter { position:absolute; inset:0; display:flex; flex-direction:column;
          align-items:center; justify-content:center; }
        .gaugecenter b { font-size:19px; font-weight:900; font-variant-numeric:tabular-nums; }
        .gaugecenter small { font-size:9px; color:var(--ink-3); font-weight:700; margin-top:1px; }

        table.plaintable { width:100%; border-collapse:collapse; font-size:11.5px; margin-top:8px; }
        table.plaintable th { text-align:left; font-size:9px; font-weight:900; letter-spacing:.08em;
          text-transform:uppercase; color:var(--ink-3); padding:0 8px 6px 0; border-bottom:1px solid var(--line-2); }
        table.plaintable td { padding:7px 8px 7px 0; border-bottom:1px solid var(--line); }
        table.plaintable td.num { text-align:right; font-variant-numeric:tabular-nums; font-weight:800; }

        .seasoncols { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
        .seasonmini { text-align:center; min-width:0; }
        .seasonmini .seasonteam { font-size:11px; font-weight:900; letter-spacing:.08em;
          text-transform:uppercase; color:var(--ink-2); margin-bottom:6px;
          overflow-wrap:anywhere; }
        .seasonmini .rec { font-size:22px; font-weight:900; font-variant-numeric:tabular-nums;
          background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent; }
        .seasonmini .pf { font-size:10.5px; color:var(--ink-3); margin-top:2px; }
        .formstrip { display:flex; justify-content:center; align-items:center; gap:3px; margin-top:8px; }
        .formstrip i { width:16px; height:16px; display:flex; align-items:center; justify-content:center;
          font-size:9px; font-weight:900; font-style:normal; color:var(--field); flex:none; }
        .formstrip i.w { background:var(--accent); }
        .formstrip i.l { background:var(--flag); }
        .nextopp { font-size:10.5px; color:var(--ink-3); margin-top:8px; }

        .h2hhead { display:grid; grid-template-columns:1fr auto 1fr; align-items:center;
          gap:12px; padding-bottom:14px; margin-bottom:6px; border-bottom:1px solid var(--line); }
        .h2hside { display:flex; flex-direction:column; gap:2px; min-width:0; }
        .h2hside.away { text-align:right; }
        .h2hteam { font-size:10px; font-weight:900; letter-spacing:.08em; text-transform:uppercase;
          color:var(--ink-2); overflow-wrap:anywhere; }
        .h2hbig { font-size:30px; font-weight:900; line-height:1; font-variant-numeric:tabular-nums;
          background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent; }
        .h2hmid { display:flex; flex-direction:column; align-items:center; gap:3px; flex:none;
          font-size:9.5px; font-weight:800; color:var(--ink-3); letter-spacing:.04em;
          text-align:center; }

        .feed { display:flex; flex-direction:column; }
        .feedrow { display:grid; grid-template-columns:44px 1fr auto auto; align-items:center;
          gap:10px; padding:9px 0; border-bottom:1px solid var(--line); }
        .feedrow:last-child { border-bottom:0; }
        .feedtime { font-size:9px; font-weight:800; color:var(--ink-3);
          font-variant-numeric:tabular-nums; }
        .feedname { font-size:11.5px; font-weight:800; min-width:0;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .feedname small { color:var(--ink-3); font-weight:700; font-size:9px; margin-left:6px; }
        .feeddelta { font-size:12.5px; font-weight:900; font-variant-numeric:tabular-nums; }
        .feedrow.home .feeddelta { color:var(--accent); }
        .feedrow.away .feeddelta { color:var(--sky); }
        .feedtotal { font-size:10px; font-weight:800; color:var(--ink-3);
          font-variant-numeric:tabular-nums; min-width:34px; text-align:right; }

        .nflgame { border:1px solid var(--line); background:var(--inset); margin-bottom:8px; }
        .nflgtoggle { width:100%; background:none; border:0; padding:11px 12px; cursor:pointer;
          text-align:left; color:var(--ink); display:block; }
        .nflgtop { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .nflteams { font-size:12px; font-weight:800; color:var(--ink); }
        .nflscoreclock { display:flex; align-items:center; gap:10px; flex:none; }
        .nflscore { font-size:12px; font-weight:800; color:var(--ink); font-variant-numeric:tabular-nums; }
        .nflstate { font-size:9px; font-weight:800; color:var(--ink-3); letter-spacing:.04em; flex:none; }
        .nflgtoggle .chev { color:var(--ink-3); margin-left:6px; }
        .nflprogress-row { display:flex; align-items:center; gap:8px; margin-top:8px; }
        .nflprogress { flex:1; height:4px; background:var(--field); border:1px solid var(--line); overflow:hidden; }
        .nflprogress i { display:block; height:100%; background:var(--ink-3);
          transition:width .8s cubic-bezier(.3,.8,.4,1); }
        .nflgbody { overflow:hidden; }
        .nflgbody-inner { padding:2px 12px 16px; }
        .nflplayers { display:grid; grid-template-columns:repeat(auto-fit,minmax(80px,1fr)); gap:16px; }
        .nflplayer { text-align:center; min-width:0; }
        .nflavatar { width:46px; height:46px; border-radius:50%; background:var(--panel-2);
          border:1px solid var(--line-2); display:flex; align-items:center; justify-content:center;
          font-size:12px; font-weight:900; color:var(--ink-2); margin:0 auto 8px; }
        .nflpname { font-size:10.5px; font-weight:800; margin-bottom:3px;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .nflpts { font-size:16px; font-weight:900; font-variant-numeric:tabular-nums;
          background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
          -webkit-background-clip:text; background-clip:text;
          color:transparent; -webkit-text-fill-color:transparent; margin-bottom:1px; }
        .nflproj { font-size:9.5px; color:var(--ink-3); font-weight:700; margin-bottom:6px; }
        .nflteamtag { font-size:11px; font-weight:900; overflow-wrap:anywhere; }
        .nflteamtag.home { color:var(--accent); }
        .nflteamtag.away { color:var(--sky); }

        button.primary { width:100%; margin-top:8px; border:0; cursor:pointer;
          background:var(--accent); color:#04170A; padding:14px; font-size:12.5px; font-weight:900;
          text-transform:uppercase; letter-spacing:.14em;
          clip-path:polygon(0 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%); }

        .pageaction { display:flex; justify-content:center; margin:22px 0 4px; }
        .pagebtn { background:none; border:1px solid var(--sky); color:var(--sky);
          font-size:10.5px; font-weight:900; letter-spacing:.15em; text-transform:uppercase;
          padding:10px 26px; text-decoration:none; display:inline-flex; align-items:center; gap:9px;
          transition:background .16s ease, color .16s ease; }
        .pagebtn:hover { background:var(--sky); color:var(--field); }
        .toolfoot { margin-top:10px; padding:10px 0 4px; text-align:center; border-top:1px solid var(--line); }
        .toolfoot .gh { display:inline-flex; align-items:center; gap:7px; color:var(--ink-3);
          font-size:10px; text-transform:uppercase; letter-spacing:.16em; font-weight:900;
          text-decoration:none; }
        .toolfoot .gh::before { content:""; width:5px; height:5px; background:currentColor; transform:rotate(45deg); }
        .toolfoot .gh:hover { color:var(--accent); }

        @media (max-width:560px) {
          .hlgridouter { grid-template-columns:1fr 1fr; }
          .hlteamname:nth-of-type(2) { order:3; }
          .seasoncols, .benchwrap { grid-template-columns:1fr; }
          .gaugerow { gap:14px; }
          .mlogo { width:38px; height:38px; font-size:10px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .finalstrip, .mteam.winner .mlogo, .updated i { animation:none !important; }
          .reveal-stagger > * { transition:none; }
        }
      `}</style>

      <div className="wrap">
        <div className="toolhead">
          <a className="toolmark homelink" href="/" aria-label="Back to home">
            <svg className="mark" viewBox="0 0 1000 150" role="img" aria-label="ESPN Fantasy Tools">
              <text x="500" y="74" textAnchor="middle" fontSize="86" fontWeight="900"
                letterSpacing="-2" fontFamily={UI_FONT}>
                <tspan className="m1">ESPN</tspan><tspan className="m2"> FANTASY TOOLS</tspan>
              </text>
              <path className="rule" d="M10 100 H990" />
              <path className="rulelive" d="M10 100 H360" />
              <text x="500" y="137" textAnchor="middle" fontSize="30" fontWeight="700"
                letterSpacing="14" fill="var(--ink-3)" fontFamily={UI_FONT}>LEAGUE HQ</text>
            </svg>
          </a>
          <div className="toolid">
            <p className="eyebrow">Live Matchups</p>
            <div className="toolleague">{leagueName}</div>
          </div>
          <div className="toolctl">
            <ToolControls steps={HELP_STEPS} label="How to use Live Matchups" theme={theme} onTheme={setTheme} gearId="gearBtn" />
          </div>
        </div>

        <div className="weekbar">
          <div className="weeksel">
            <button className="weekbtn" type="button" aria-label="Previous week"
              disabled={!shownWeek || shownWeek <= 1}
              onClick={() => setWeek(Math.max(1, (shownWeek || 1) - 1))}>&lsaquo;</button>
            <span className="weeklabel">Week {shownWeek || "—"}</span>
            <button className="weekbtn" type="button"
              aria-label={shownWeek >= currentWeek ? "Already at the current week" : "Next week"}
              title={shownWeek >= currentWeek ? "Already at the current week" : undefined}
              disabled={!shownWeek || shownWeek >= currentWeek}
              onClick={() => setWeek((shownWeek || 1) + 1)}>&rsaquo;</button>
          </div>
          <div className="updated"><i />{isCurrent ? agoLabel : `Week ${shownWeek} · complete`}</div>
        </div>

        {error && <div className="msg err" style={{ display: "block" }}>{error}</div>}

        {digest && !digest.identified && (
          <div className="msg info" style={{ display: "block" }}>
            Team names have not loaded yet. Give it a moment and refresh.
          </div>
        )}

        <div className="matchlist">
          {loading && !digest ? (
            <div className="placeholder"><b>Loading this week</b><span>Fetching the current scoreboard.</span></div>
          ) : games.length ? (
            games.map((g) => (
              <MatchCard key={g.id} g={g} tz={tz} timelineRows={timelineRows} lastTick={lastTick}
                expandAll={expandAll}
                events={events} h2h={h2h}
                pinned={myTeam && (g.home.teamId === myTeam || g.away.teamId === myTeam)} />
            ))
          ) : (
            <div className="placeholder">
              <b>No matchups scheduled</b>
              <span>Nothing is on the board for this week yet.</span>
            </div>
          )}
        </div>

        {idle && (
          <div className="msg info" style={{ display: "block" }}>
            Live updates paused after 4 hours idle. Tap anywhere to resume.
          </div>
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
