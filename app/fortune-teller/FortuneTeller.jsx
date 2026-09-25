import ScrollBox from "../shared/ScrollBox.jsx";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PALETTES, BASE_CSS, BACKDROP, TEAM_COOKIE, THEME_COOKIE } from "../../src/ui.js";
import TeamSelect from "../shared/TeamSelect.jsx";
import Instructions from "../shared/Instructions.jsx";
import SettingsMenu from "../shared/SettingsMenu.jsx";
import TeamLogo from "../shared/TeamLogo.jsx";
import { CHROME_CSS, FT_CSS } from "./css.js";
import { DIGITS, ordinal, blockOf, classify, placeLabel, standings, brackets, pct } from "./engine.js";
import { espnPoints, seedOrder } from "./history.js";
import { isFinal, finalOrder, finalOdds, flattenStandings, definiteBlock } from "./final.js";
import { makeCounter } from "./counting.js";
import { encodeShare, decodeShare, datasetTag } from "./sharelink.js";

const INSTRUCTIONS = [
  [1, "Pick your team", "Choose your team at the top. The dial and the finish board show your chances across every way the rest of the regular season can go."],
  [2, "Read the map", "Every remaining game is a switch with three results: either team wins, or they tie. The line down the side is the path you are looking at. Each result is coloured by where it would leave you: green is a playoff place, amber is level on record right at the cut, red is outside."],
  [3, "Set a result", "Tap any result to set it. From then on the odds on the map count only the ways the season can go where that result happens, and the meter on each result shows that share. Games that stop mattering to you fold away, and games that start to matter appear."],
  [4, "Jump to a path", "Best path opens the results that leave you highest. ESPN projected wins gives every game to the team ESPN projects to win. Simplest path shows the fewest results that guarantee you a playoff spot. You win out and You lose out settle your own games and give the rest to ESPN's projected winners. Once every game has been played, the jumps step aside."],
  [5, "Standings and brackets", "The final standings beside the map show the table this path produces, and the brackets below show who would play whom. Teams level on record are highlighted together: the league breaks those ties on points still to be scored, so use the arrows to put them in any order and the brackets follow."],
  [6, "What-if", "Once games inside the simulated weeks have been played, switch on What-if to change a result that already happened and see how things would have turned out."],
  [7, "Before the map is built", "Until the league is close enough to the end of the regular season for every way it can go to be mapped, the page shows ESPN's playoff odds and the standings as they are, with the brackets seeded from them. Switch the seeding to ESPN's odds to see the brackets the forecasts point to. The map appears here once it has been built."],
];
const DUR = 320, EASE = "cubic-bezier(.65,0,.35,1)";
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function readCookie(name) { try { const m = new RegExp("(?:^|; )" + name + "=([^;]*)").exec(document.cookie); return m ? decodeURIComponent(m[1]) : ""; } catch (e) { return ""; } }
function writeCookie(name, value) { try { document.cookie = name + "=" + encodeURIComponent(value) + "; path=/; max-age=31536000; samesite=lax"; } catch (e) { /* this visit only */ } }
const fmtPts = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const stillness = () => document.documentElement.classList.contains("stillness") || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const oddsCls = (v) => (v >= 0.5 ? "in" : v >= 0.05 ? "cut" : "out");
const recStr = (r) => `${r.w}-${r.l}${r.t ? "-" + r.t : ""}`;
const winPct = (p) => (p < 0.01 ? "<1%" : p > 0.99 ? ">99%" : Math.round(p * 100) + "%");

/* A value changes by counting to its new figure rather than jumping there
   (the "value change" principle): ease-out, about two-thirds of a second. */
function useTween(target, dur = 680) {
  const [v, setV] = useState(0); const cur = useRef(0); const raf = useRef(0);
  useEffect(() => {
    const from = cur.current, to = Number.isFinite(target) ? target : 0;
    if (stillness() || from === to) { cur.current = to; setV(to); return undefined; }
    const t0 = performance.now(); cancelAnimationFrame(raf.current);
    const step = (now) => { const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3), x = from + (to - from) * e;
      cur.current = x; setV(x); if (t < 1) raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, dur]);
  return v;
}
function Share({ value }) { const v = useTween(value); return <React.Fragment>{pct(v, 1)}</React.Fragment>; }
function Pop({ children, k }) { return <span className="pop" key={k}>{children}</span>; }

function Gauge({ value, cls }) {
  const v = Math.max(0, Math.min(1, useTween(value, 820)));
  const cx = 110, cy = 104, r = 84, A0 = 150, SW = 240;
  const pt = (deg, rr = r) => { const a = (deg * Math.PI) / 180; return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; };
  const arc = (a0, a1) => { const [x0, y0] = pt(a0), [x1, y1] = pt(a1); return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
  const ticks = [];
  for (let k = 0; k <= 20; k++) { const a = A0 + (SW * k) / 20, major = k % 5 === 0, [x0, y0] = pt(a, r - 16), [x1, y1] = pt(a, r - (major ? 25 : 20));
    ticks.push(<line key={k} className={major ? "maj" : ""} x1={x0} y1={y0} x2={x1} y2={y1} />); }
  return (
    <svg className={"gauge " + cls} viewBox="0 0 220 190" aria-hidden="true">
      <defs><linearGradient id="gaugefill" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" className="gs0" /><stop offset="100%" className="gs1" /></linearGradient></defs>
      <path className="gtrack" d={arc(A0, A0 + SW)} />
      <g className="gticks">{ticks}</g>
      {v > 0.0005 ? <path className="gglow" d={arc(A0, A0 + SW * v)} /> : null}
      {v > 0.0005 ? <path className="gval" d={arc(A0, A0 + SW * v)} /> : null}
    </svg>
  );
}

function Slot({ data, slot, me, tied, games, tone }) {
  if (!slot) return <div className="slot tbd"><span className="sd" /><span className="nm">Bye</span></div>;
  if (slot.from) {
    const g = games.find((x) => x.id === slot.of);
    return <div className="slot tbd"><span className="sd">{slot.from === "Winner" ? "W" : "L"}</span>
      <span className="nm">{slot.from} of {g && g.a && g.a.seed ? `${g.a.seed} v ${g.b.seed}` : g ? g.round.toLowerCase() : "earlier game"}</span></div>;
  }
  const t = data.teams[slot.ti];
  return (
    <div className={"slot" + (slot.ti === me ? " me" : "")}>
      <span className="sd">{slot.seed}</span><span className="lg"><TeamLogo src={t.logo} alt="" /></span><span className="nm">{t.name}</span>
      {tied ? <span className="tiemark" data-tone={tone} title="Level on record: seeded by the order in the standings">T</span> : null}
    </div>
  );
}
function Match({ data, m, me, tiedTeams, games }) {
  const toneFor = (s) => (s && !s.from && tiedTeams.get ? tiedTeams.get(s.ti) : undefined);
  const hasMe = [m.a, m.b].some((s) => s && !s.from && s.ti === me);
  return (
    <div className={"match" + (hasMe ? " hasme" : "")} data-bk={m.id}>
      <span className="rnd">{m.round}</span>
      <Slot data={data} slot={m.a} me={me} tied={m.a && !m.a.from && tiedTeams.has(m.a.ti)} tone={toneFor(m.a)} games={games} />
      <Slot data={data} slot={m.b} me={me} tied={m.b && !m.b.from && tiedTeams.has(m.b.ti)} tone={toneFor(m.b)} games={games} />
    </div>
  );
}
function useLinks(ref, links) {
  useLayoutEffect(() => {
    const box = ref.current; if (!box) return undefined;
    const svg = box.querySelector(".bklinks"); let raf = 0;
    const draw = () => {
      raf = 0; const o = box.getBoundingClientRect(); let out = "";
      for (const [a, b, kind] of links) {
        const A = box.querySelector(`[data-bk="${a}"]`), B = box.querySelector(`[data-bk="${b}"]`); if (!A || !B) continue;
        const ra = A.getBoundingClientRect(), rb = B.getBoundingClientRect();
        const x0 = ra.right - o.left, y0 = ra.top - o.top + ra.height / 2, x1 = rb.left - o.left, y1 = rb.top - o.top + rb.height / 2, mx = (x0 + x1) / 2, sg = Math.sign(y1 - y0) || 1;
        out += `<path class="${kind}" d="M${x0} ${y0} H${mx - 6} Q${mx} ${y0} ${mx} ${y0 + sg * 6} V${y1 - sg * 6} Q${mx} ${y1} ${mx + 6} ${y1} H${x1}"/>`;
      }
      svg.innerHTML = out;
    };
    const go = () => { if (!raf) raf = requestAnimationFrame(draw); };
    go(); const ro = new ResizeObserver(go); ro.observe(box);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  });
}

/* Odds by week: played weeks as a solid line, the rest as ESPN's projections
   would have them. Lines are SVG with strokes that never stretch; dots and
   labels are HTML placed by percentage, so the chart fills any height crisply. */
function OddsByWeek({ points, k, nowLabel = "Now", note = null }) {
  const wipe = useRef(null), plot = useRef(null), axis = useRef(null);
  // Week labels give way when there is no room: Now first, then the ends, then the weeks between.
  useDeclutter(axis, "span", (el) => (el.classList.contains("now") ? 3 : el.dataset.edge ? 2 : 1), null, [k, (points || []).map((p) => p.week).join(",")]);
  useDeclutter(plot, ".owdot b", (el) => (el.parentElement.classList.contains("now") ? 3 : el.parentElement.classList.contains("played") ? 2 : 1) + Number(el.dataset.i) / 1000, "below", [k, points.map((p) => p.v).join(",")]);
  useLayoutEffect(() => { if (wipe.current && !stillness()) wipe.current.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: 900, delay: 150, easing: "cubic-bezier(.45,0,.2,1)", fill: "both" }); }, [k]);
  if (!points || !points.length) return null;
  // Points are spaced by order, not by week number: a stretch with nothing recorded (say, before the
  // site began keeping ESPN's figures) must not squeeze the weeks that do have one. The axis names each week.
  const order = [...new Set(points.map((p) => p.week))].sort((a, b) => a - b), at = new Map(order.map((w, i) => [w, i]));
  const X = (w) => (order.length === 1 ? 50 : 6 + (at.get(w) / (order.length - 1)) * 88), Y = (v) => 8 + (1 - v) * 80;
  const espn = points.filter((p) => p.kind === "espn"), played = points.filter((p) => p.kind === "played"), proj = points.filter((p) => p.kind === "projected");
  const now = played.length ? played[played.length - 1] : espn[espn.length - 1], many = points.length > 8;
  const line = (ps) => ps.map((p, i) => `${i ? "L" : "M"}${X(p.week).toFixed(2)} ${Y(p.v).toFixed(2)}`).join(" ");
  const area = played.length > 1 ? `${line(played)} L${X(now.week)} 88 L${X(played[0].week)} 88 Z` : "";
  return (
    <div className="oddsweek">
      <div className="owhead"><span className="zl">Odds by week</span><span className="owkey">{espn.length ? <React.Fragment><i className="espnk" />ESPN's odds</React.Fragment> : null}{played.length ? <React.Fragment><i className="solid" />{espn.length ? "Simulated" : "Played"}</React.Fragment> : null}{proj.length ? <React.Fragment><i className="dash" />If ESPN's projections hold</React.Fragment> : null}</span></div>
      <div className="owplot" ref={plot}>
        {[1, 0.5, 0].map((v) => <span key={v} className="owgrid" style={{ top: `${Y(v)}%` }}><em>{v * 100}%</em></span>)}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="owfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" className="of0" /><stop offset="100%" className="of1" /></linearGradient></defs>
          {area ? <path className="owarea" d={area} /> : null}
          {espn.length > 1 ? <path className="owespn" d={line(espn)} /> : null}
          {played.length > 1 ? <path className="owline" d={line(played)} /> : null}
          {proj.length && now ? <path className="owproj" d={line([now, ...proj])} /> : null}
        </svg>
        {points.map((p, i) => (
          <span key={i} className={"owdot " + p.kind + (p === now ? " now" : "") + (p.v > 0.8 ? " high" : "")} style={{ left: `${X(p.week)}%`, top: `${Y(p.v)}%` }}>
            <b data-i={i}>{pct(p.v, 1)}</b>
          </span>
        ))}
        <span className="owwipe" ref={wipe} />
      </div>
      <div className="owaxis" ref={axis}>{points.map((p, i) => <span key={i} className={p === now ? "now" : ""} data-edge={i === 0 || i === points.length - 1 ? "1" : undefined} style={{ left: `${X(p.week)}%` }}>{p === now ? nowLabel : p.week === 0 ? "Pre" : many ? String(p.week) : `Wk ${p.week}`}</span>)}</div>
      {note ? <p className="ownote">{note}</p> : null}
    </div>
  );
}

/**
 * Keeps labels from overlapping one another or leaving their box. Labels are placed
 * in priority order; one that would collide first tries its alternative position (a
 * class, such as "below"), and gives way if it still collides. Runs after layout and
 * again when the box resizes, writing classes to the labels only (never to the box).
 */
function useDeclutter(ref, selector, priority, alt, deps) {
  useLayoutEffect(() => {
    const box = ref.current; if (!box) return undefined;
    let raf = 0;
    const run = () => {
      raf = 0; const labels = [...box.querySelectorAll(selector)];
      labels.forEach((el) => { el.classList.remove("hid"); if (alt) el.classList.remove(alt); });
      const o = box.getBoundingClientRect(), kept = [];
      const hits = (r) => r.left < o.left - 2 || r.right > o.right + 2 || r.top < o.top - 26 || kept.some((q) => r.left < q.right + 3 && r.right > q.left - 3 && r.top < q.bottom + 1 && r.bottom > q.top - 1);
      for (const el of labels.slice().sort((a, b) => priority(b) - priority(a))) {
        let r = el.getBoundingClientRect();
        if (hits(r) && alt) { el.classList.add(alt); r = el.getBoundingClientRect(); }
        if (hits(r)) { if (alt) el.classList.remove(alt); el.classList.add("hid"); continue; }
        kept.push(r);
      }
    };
    run();
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(run); });
    ro.observe(box);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, deps);
}

/* The same header, controls, backdrop and footer every tool carries. */
function Chrome({ leagueName, children }) {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") || "dark");
  const [showSettings, setShowSettings] = useState(false);
  const [showInstr, setShowInstr] = useState(false);
  const gearRef = useRef(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; writeCookie(THEME_COOKIE, theme); }, [theme]);
  return (
    <React.Fragment>
      <style dangerouslySetInnerHTML={{ __html: `${PALETTES}\n${BASE_CSS}\n${CHROME_CSS}\n${FT_CSS}` }} />
      <div dangerouslySetInnerHTML={{ __html: BACKDROP }} />
      <div className="wrap">
        <div className="toolhead">
          <a className="toolmark homelink" href="/" aria-label="Back to home">
            <svg className="mark" viewBox="0 0 1000 150" role="img" aria-label="ESPN Fantasy Tools">
              <text x="500" y="74" textAnchor="middle" textLength="980" lengthAdjust="spacingAndGlyphs" fontSize="86" fontWeight="900" letterSpacing="-2" fontFamily="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
                <tspan className="m1">ESPN</tspan><tspan className="m2"> FANTASY TOOLS</tspan></text>
              <path className="rule" d="M10 100 H990" /><path className="rulelive" d="M10 100 H360" />
              <text x="500" y="137" textAnchor="middle" fontSize="30" fontWeight="700" letterSpacing="14" fill="var(--ink-3)" fontFamily="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">LEAGUE HQ</text>
            </svg>
          </a>
          <div className="toolid"><p className="eyebrow">Fortune Teller</p><div className="toolleague">{leagueName || "\u00a0"}</div></div>
          <div className="toolctl">
            <button className="ctlbtn" type="button" title="How to use this tool" onClick={() => setShowInstr(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9.4" /><path d="M9.2 9.3a2.8 2.8 0 1 1 3.9 2.9c-.9.5-1.4 1-1.4 2.1" /><circle cx="12" cy="17.2" r=".55" fill="currentColor" stroke="none" /></svg>
            </button>
            <button className="ctlbtn" type="button" title="Site settings" ref={gearRef} aria-haspopup="dialog" onClick={() => setShowSettings((s) => !s)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.1" /><path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a2 2 0 1 1-4 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9H3a2 2 0 1 1 0-4h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.5 1.5 0 0 0 1.7.3H9a1.5 1.5 0 0 0 .9-1.4V3a2 2 0 1 1 4 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.5 1.5 0 0 0-.3 1.7V9a1.5 1.5 0 0 0 1.4.9h.2a2 2 0 1 1 0 4h-.1a1.5 1.5 0 0 0-1.4.9z" /></svg>
            </button>
            <SettingsMenu open={showSettings} onClose={() => setShowSettings(false)} theme={theme} onTheme={setTheme} anchorRef={gearRef} />
          </div>
        </div>
        {children}
        <div className="grow" />
        <div className="pageaction"><a className="pagebtn" href="/">&larr; Back to home</a></div>
        <div className="toolfoot"><a className="gh" href="https://github.com/shortcutsbin-netizen" target="_blank" rel="noopener noreferrer">GitHub - shortcutsbin-netizen</a></div>
      </div>
      <Instructions open={showInstr} steps={INSTRUCTIONS} onClose={() => setShowInstr(false)} label="How to use Fortune Teller" />
    </React.Fragment>
  );
}

/* What the counter is asked for a team, a week, the results set and the results played. */
function stateRequest(data, ti, trimIdx, pins, settled) {
  const G = data.games.length, trim = data.trims[trimIdx], actual = data.future.map((f) => f.digit);
  const own = data.games.map((g, j) => j >= trim.fixed && (g.ai === ti || g.bi === ti));
  const outFor = (won) => { if (!own.some(Boolean)) return null; const p = Int8Array.from(settled); data.games.forEach((g, j) => { if (own[j]) p[j] = (g.ai === ti) === won ? 1 : 2; }); return p; };
  const series = [];
  for (let k = 0; k <= trimIdx; k++) { const p = new Int8Array(G).fill(-1); for (let j = 0; j < data.trims[k].fixed; j++) p[j] = actual[j]; series.push({ week: data.trims[k].thru, kind: "played", pins: p }); }
  const lastWk = Math.max(...data.games.map((g) => g.week)), p = new Int8Array(G).fill(-1);
  for (let j = 0; j < trim.fixed; j++) p[j] = actual[j];
  for (let w = trim.thru + 1; w <= lastWk; w++) { data.games.forEach((g, j) => { if (g.week === w) p[j] = g.pA >= g.pB ? 1 : 2; }); series.push({ week: w, kind: "projected", pins: Int8Array.from(p) }); }
  return { key: `${ti}:${trimIdx}:${Array.from(pins).join("")}:${Array.from(settled).join("")}`, team: `${ti}:${trimIdx}`, pins, settled,
    places: data.places, n: data.teams.length, extras: { winOut: outFor(true), loseOut: outFor(false), series } };
}

/* Every state the page can be in before a map exists, each saying what is actually going on. */
function NotReady({ p }) {
  const st = p && p.state, b = p && p.build;
  const away = p && p.opensAfterWeek != null && p.lastSettled != null ? Math.max(0, p.opensAfterWeek - p.lastSettled) : null;
  const share = b && b.n ? Math.min(1, ((b.team || 0) + (b.parts > 1 && b.next !== 'merge' ? (b.part || 0) / b.parts : 0)) / b.n) : 0;
  let title, body, extra = null;
  if (st === 'early') { title = `Opens after week ${p.opensAfterWeek}`; body = `Fortune Teller maps every way the rest of the regular season can go. That becomes possible once week ${p.opensAfterWeek} has been played${away ? `, ${away === 1 ? "a week" : away + " weeks"} from now` : ""}.`; }
  else if (st === 'available') { title = "Ready when the league switches it on"; body = "Everything is in place for this season's map. The league's administrator can switch Fortune Teller on in Site Configuration."; }
  else if (st === 'building' || st === 'updating') { title = st === 'building' ? "Mapping every way the season can go" : "Updating the map"; body = "It builds in the background and appears here when it is done. There is no need to keep this page open.";
    extra = <span className="ftprog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}><i style={{ transform: `scaleX(${share})` }} /></span>; }
  else if (st === 'failed') { title = "This week's map could not be built"; body = "The league's administrator can see why in Site Configuration and try again."; }
  else if (st === 'season-over') { title = "The regular season is over"; body = "Fortune Teller maps the regular season, so there is nothing left to map this year. Follow the postseason in Live Matchups.";
    extra = <a className="ftbtn" href="/apps/live-matchups/">Open Live Matchups</a>; }
  else if (st === 'no-data') { title = "The league's data has not been pulled yet"; body = "Once the site has pulled the league from ESPN, Fortune Teller will say when it can open."; }
  else { title = "The simulation has not run yet"; body = "Fortune Teller maps every way the rest of the regular season can go once the league is close enough to the end for that to be done in full."; }
  return <div className="panel ftstate"><div className="placeholder"><b>{title}</b><span>{body}</span>{extra}</div></div>;
}

/* Sim %, with the same markers as the dashboard's Playoff % at the extremes. */
function simCell(v) {
  if (v == null) return <span className="dim">—</span>;
  if (v >= 0.9995) return <span className="stflag in">Clinched</span>;
  if (v <= 0.0005) return <span className="stflag out">Eliminated</span>;
  return <span className="stpct">{pct(v, 1)}</span>;   // the dial's own formatter, so the page agrees with itself
}

/**
 * The page before a map exists: everything general, from ESPN's figures and the standings as
 * they are. The dial, the odds by week, the standings and both brackets; in place of the map,
 * what is happening with it. The brackets seed from the standings or, if asked, ESPN's odds.
 */
function Preview({ data }) {
  const pv = data.preview, teams = pv.teams, n = teams.length, places = pv.places;
  const [ti, setTi] = useState(() => { const id = Number(readCookie("eft_team")); const i = teams.findIndex((t) => t.id === id); return i >= 0 ? i : 0; });
  const [seedBy, setSeedBy] = useState("standings");
  const winRef = useRef(null), conRef = useRef(null);
  useLinks(winRef, [["sf1", "final", "w"], ["sf2", "final", "w"], ["sf1", "third", "l"], ["sf2", "third", "l"]]);
  useLinks(conRef, [["c5", "p5", "w"], ["c7", "p5", "w"], ["c5", "p7", "l"], ["c9", "p7", "w"], ["c7", "p9", "l"], ["c9", "p9", "l"]]);
  const me = teams[ti], odds = me.playoffPct;
  const byRank = seedOrder(teams, "standings"), bk = brackets(seedOrder(teams, seedBy), places, pv.consolation);
  const status = odds == null ? "No odds yet" : odds >= 0.9995 ? "Clinched" : odds <= 0.0005 ? "Eliminated" : "In the hunt";
  const none = new Map();
  // ESPN's figure after each settled week, ending on today's.
  const pts = espnPoints(data.espnHistory, me.id); if (odds != null && !pts.some((q) => q.week === pv.weeksPlayed)) pts.push({ week: pv.weeksPlayed || 0, v: odds, kind: "espn" });
  pts.sort((a, b) => a.week - b.week);
  const teamOptions = teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ value: t.id, label: t.name, logo: t.logo }));
  const choose = (id) => { const i = teams.findIndex((t) => t.id === Number(id)); if (i >= 0) { setTi(i); writeCookie("eft_team", String(teams[i].id)); } };
  const espnCell = (v) => (v == null ? <span className="dim">—</span> : v >= 0.9995 ? <span className="stflag in">Clinched</span> : v <= 0.0005 ? <span className="stflag out">Eliminated</span> : <span className="stpct">{pct(v, 1)}</span>);
  const recStr = (t) => `${t.w}-${t.l}${t.t ? `-${t.t}` : ""}`;
  return (
    <Chrome leagueName={data.leagueName}>
      <div className="pickrow"><TeamSelect label="My team" value={me.id} placeholder="Select your team" options={teamOptions} onChange={choose} /></div>
      <div className="hero">
        <div className="panel oddspanel ftin" style={{ "--d": "40ms" }}>
          <div className="panelhead"><span className="t">Playoff odds</span><span className="count">ESPN's forecast</span></div>
          <div className="gaugewrap">
            <Gauge value={odds ?? 0} cls={oddsCls(odds ?? 0)} />
            <div className={"gaugeval " + oddsCls(odds ?? 0)}><b>{odds == null ? "–" : <Share value={odds} />}</b><span>according to ESPN</span></div>
          </div>
          <div className="chips"><span className={"chip st " + (status === "Clinched" ? "in" : status === "Eliminated" ? "out" : "hunt")}><i />{status}</span></div>
          <div className="stats">
            <div className="stat"><span>Current place</span><b>{ordinal(byRank.indexOf(ti) + 1)}</b></div>
            <div className="stat"><span>Record</span><b>{recStr(me)}</b></div>
            <div className="stat"><span>Points for</span><b>{me.pf.toFixed(1)}</b></div>
          </div>
        </div>
        <div className="panel finpanel chartonly ftin" style={{ "--d": "80ms" }}>
          <div className="panelhead"><span className="t">Odds by week</span><span className="count">ESPN's forecast after each week</span></div>
          <OddsByWeek points={pts} k={`pv:${ti}`} note={pts.length < 3 ? "ESPN's odds are kept after every week, so this line grows as the season goes." : null} />
        </div>
      </div>

      <div className="sechead"><span className="t">The map</span><span className="rule" /><span className="count">every way the season can go</span></div>
      <NotReady p={data.pipeline} />

      <div className="sechead"><span className="t">Standings</span><span className="rule" /><span className="count">as they stand</span></div>
      <div className="panel ftin">
        <ScrollBox>
          <table className="datatable ftst">
            <thead><tr><th className="c-rank"><span className="lbl">Place</span></th><th className="col-team"><span className="lbl">Team</span></th><th className="c-key"><span className="lbl">Record</span></th><th className="c-num"><span className="lbl">PF</span></th><th className="c-num"><span className="lbl">Playoff%</span></th></tr></thead>
            <tbody>
              {byRank.map((i, k) => { const t = teams[i], seed = k + 1; return (
                <React.Fragment key={t.id}>
                  <tr className={(i === ti ? "me" : "") + (seed <= places ? " po" : "")}>
                    <td className="c-rank">{seed <= 3 ? <span className={"medal " + ["g", "s", "b"][seed - 1]} title={ordinal(seed)}>{seed}</span> : seed}</td>
                    <td className="col-team"><div className="stname"><TeamLogo src={t.logo} alt="" className="tklogo" /><div className="stnamewrap"><b>{t.name}</b></div></div></td>
                    <td className="c-key">{recStr(t)}</td>
                    <td className="c-num">{t.pf.toFixed(1)}</td>
                    <td className="c-num">{espnCell(t.playoffPct)}</td>
                  </tr>
                  {seed === places && seed < n ? <tr className="porow" aria-hidden="true"><td colSpan={5}><span><i />Playoffs</span></td></tr> : null}
                </React.Fragment>); })}
            </tbody>
          </table>
        </ScrollBox>
      </div>

      <div className="sechead"><span className="t">If the season ended today</span><span className="rule" /><span className="count">seeded by {seedBy === "espn" ? "ESPN's playoff odds" : "the standings"}</span></div>
      <div className="seedby" role="group" aria-label="Seed the brackets by">
        <button type="button" className="ftbtn" aria-pressed={seedBy === "standings"} onClick={() => setSeedBy("standings")}>Standings</button>
        <button type="button" className="ftbtn" aria-pressed={seedBy === "espn"} onClick={() => setSeedBy("espn")}>ESPN playoff odds</button>
      </div>
      <div className={"bkrow" + (bk.consolation.length ? "" : " solo")}>
        <div className="panel">
          <div className="panelhead"><span className="t">Playoffs</span><span className="count">top {places}</span></div>
          <div className="board ftfade" key={"w" + seedBy} ref={winRef}><svg className="bklinks" aria-hidden="true" />
            <div className="bcol">{bk.winners.map((m) => <Match key={m.id} data={pv} m={m} me={ti} tiedTeams={none} games={bk.winners} />)}</div>
            <div className="bcol late">{bk.later.map((m) => <Match key={m.id} data={pv} m={m} me={ti} tiedTeams={none} games={bk.winners} />)}</div>
          </div>
        </div>
        {bk.consolation.length ? (
          <div className="panel">
            <div className="panelhead"><span className="t">Consolation ladder</span><span className="count">places {places + 1}–{n}</span></div>
            <div className="board ftfade" key={"c" + seedBy} ref={conRef}><svg className="bklinks" aria-hidden="true" />
              <div className="bcol">{bk.consolation.map((m) => <Match key={m.id} data={pv} m={m} me={ti} tiedTeams={none} games={bk.consolation} />)}</div>
              <div className="bcol late">{bk.ladder.map((m) => <Match key={m.id} data={pv} m={m} me={ti} tiedTeams={none} games={bk.consolation} />)}</div>
            </div>
          </div>) : null}
      </div>
    </Chrome>
  );
}

/**
 * After the regular season: the final standings and the postseason they set up, from the map when
 * one was built (every game played, level teams ordered by the league's rule and then points) or
 * from ESPN's final standings when none was. Every team is in or out, so the page says Clinched or
 * Eliminated rather than a percentage; the odds chart looks back over the whole season.
 */
function FinalView({ data, onReplay }) {
  const tree = !!data.ready;
  const src = useMemo(() => {
    if (tree) {
      const last = data.trims[Math.max(0, Math.min(data.trims.length - 1, data.activeTrim ?? data.trims.length - 1))];
      const { order, rows } = finalOrder(data, last);
      const rec = new Map(rows.map((r) => [r.ti, r.record]));
      return { teams: data.teams.map((t, i) => ({ ...t, fw: rec.get(i).w, fl: rec.get(i).l, ft: rec.get(i).t, fpf: last.pf[i] })), order, places: data.places, consolation: data.consolation, last };
    }
    const pv = data.preview;
    return { teams: pv.teams.map((t) => ({ ...t, fw: t.w, fl: t.l, ft: t.t, fpf: t.pf })), order: seedOrder(pv.teams, "standings"), places: pv.places, consolation: pv.consolation };
  }, [data, tree]);
  const { teams, order, places } = src, n = teams.length;
  const [ti, setTi] = useState(() => { const id = Number(readCookie("eft_team")); const i = teams.findIndex((t) => t.id === id); return i >= 0 ? i : order[0]; });
  const winRef = useRef(null), conRef = useRef(null);
  useLinks(winRef, [["sf1", "final", "w"], ["sf2", "final", "w"], ["sf1", "third", "l"], ["sf2", "third", "l"]]);
  useLinks(conRef, [["c5", "p5", "w"], ["c7", "p5", "w"], ["c5", "p7", "l"], ["c9", "p7", "w"], ["c7", "p9", "l"], ["c9", "p9", "l"]]);
  const me = teams[ti], place = order.indexOf(ti), made = place < places;
  const bk = brackets(order, places, src.consolation), none = new Map();
  const recStr = (t) => `${t.fw}-${t.fl}${t.ft ? `-${t.ft}` : ""}`;
  const flag = (inn) => <span className={"stflag " + (inn ? "in" : "out")}>{inn ? "Clinched" : "Eliminated"}</span>;
  const teamOptions = teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ value: t.id, label: t.name, logo: t.logo }));
  const choose = (id) => { const i = teams.findIndex((t) => t.id === Number(id)); if (i >= 0) { setTi(i); writeCookie("eft_team", String(teams[i].id)); } };
  // How the odds moved: ESPN's figure before the simulation, the simulation's after, ending in or out.
  const pts = (() => {
    if (tree) {
      const first = data.trims[0].thru, sim = data.trims.map((tr) => { const o = finalOdds(data, tr) || tr.odds; return o && typeof o[ti] === "number" ? { week: tr.thru, v: o[ti], kind: "played" } : null; }).filter(Boolean);
      return [...espnPoints(data.espnHistory, me.id, first), ...sim];
    }
    const p = espnPoints(data.espnHistory, me.id), wk = data.preview.weeksPlayed || 0;
    if (!p.some((q) => q.week === wk)) p.push({ week: wk, v: made ? 1 : 0, kind: "espn" });
    return p.sort((a, b) => a.week - b.week).map((q) => (q.week === wk ? { ...q, v: made ? 1 : 0 } : q));
  })();
  return (
    <Chrome leagueName={data.leagueName}>
      <div className="pickrow"><TeamSelect label="My team" value={me.id} placeholder="Select your team" options={teamOptions} onChange={choose} /></div>
      <div className="ftfinal panel ftin" role="status">
        <div className="fftxt"><span className="zl">The regular season is over</span>
          <b>{made ? `${me.name} made the playoffs as the ${ordinal(place + 1)} seed.` : `${me.name} finished ${ordinal(place + 1)}${src.consolation ? " and plays on in the consolation ladder" : ""}.`}</b>
          <span>The final standings below set the postseason{tree ? ". Replay the season to see how any result would have changed them." : "."}</span></div>
        <div className="ffact"><a className="ftbtn" href="/apps/live-matchups/">Follow the postseason</a>{onReplay ? <button type="button" className="ftbtn" onClick={onReplay}>Replay the season</button> : null}</div>
      </div>
      <div className="hero">
        <div className="panel oddspanel ftin" style={{ "--d": "40ms" }}>
          <div className="panelhead"><span className="t">Your season</span><span className="count">final</span></div>
          <div className="finalres"><b className={"fplace " + (made ? "in" : "out")}>{ordinal(place + 1)}</b><span>of {n}</span>{flag(made)}</div>
          <div className="stats">
            <div className="stat"><span>Record</span><b>{recStr(me)}</b></div>
            <div className="stat"><span>Points for</span><b>{me.fpf.toFixed(1)}</b></div>
            <div className="stat"><span>{made ? "Playoff seed" : "Finished"}</span><b>{made ? place + 1 : ordinal(place + 1)}</b></div>
          </div>
        </div>
        <div className="panel finpanel chartonly natural ftin" style={{ "--d": "80ms" }}>
          <div className="panelhead"><span className="t">How your odds moved</span><span className="count">the whole regular season</span></div>
          <OddsByWeek points={pts} k={`fin:${ti}`} nowLabel="Final" note={pts.length < 3 ? "ESPN's odds are kept after every week, so earlier seasons show more of the line." : null} />
        </div>
      </div>

      <div className="sechead"><span className="t">Final standings</span><span className="rule" /><span className="count">the regular season</span></div>
      <div className="panel ftin">
        <ScrollBox>
          <table className="datatable ftst">
            <thead><tr><th className="c-rank"><span className="lbl">Place</span></th><th className="col-team"><span className="lbl">Team</span></th><th className="c-key"><span className="lbl">Record</span></th><th className="c-num"><span className="lbl">PF</span></th><th className="c-num"><span className="lbl">Playoffs</span></th></tr></thead>
            <tbody>
              {order.map((i, k) => { const t = teams[i], seed = k + 1, inn = seed <= places; return (
                <React.Fragment key={t.id}>
                  <tr className={(i === ti ? "me" : "") + (inn ? " po" : "")}>
                    <td className="c-rank">{seed <= 3 ? <span className={"medal " + ["g", "s", "b"][seed - 1]} title={ordinal(seed)}>{seed}</span> : seed}</td>
                    <td className="col-team"><div className="stname"><TeamLogo src={t.logo} alt="" className="tklogo" /><div className="stnamewrap"><b>{t.name}</b></div></div></td>
                    <td className="c-key">{recStr(t)}</td>
                    <td className="c-num">{t.fpf.toFixed(1)}</td>
                    <td className="c-num">{flag(inn)}</td>
                  </tr>
                  {seed === places && seed < n ? <tr className="porow" aria-hidden="true"><td colSpan={5}><span><i />Playoffs</span></td></tr> : null}
                </React.Fragment>); })}
            </tbody>
          </table>
        </ScrollBox>
      </div>

      <div className="sechead"><span className="t">The postseason</span><span className="rule" /><span className="count">seeded from the final standings</span></div>
      <div className={"bkrow" + (bk.consolation.length ? "" : " solo")}>
        <div className="panel">
          <div className="panelhead"><span className="t">Playoffs</span><span className="count">top {places}</span></div>
          <div className="board ftfade" ref={winRef}><svg className="bklinks" aria-hidden="true" />
            <div className="bcol">{bk.winners.map((m) => <Match key={m.id} data={src} m={m} me={ti} tiedTeams={none} games={bk.winners} />)}</div>
            <div className="bcol late">{bk.later.map((m) => <Match key={m.id} data={src} m={m} me={ti} tiedTeams={none} games={bk.winners} />)}</div>
          </div>
        </div>
        {bk.consolation.length ? (
          <div className="panel">
            <div className="panelhead"><span className="t">Consolation ladder</span><span className="count">places {places + 1}–{n}</span></div>
            <div className="board ftfade" ref={conRef}><svg className="bklinks" aria-hidden="true" />
              <div className="bcol">{bk.consolation.map((m) => <Match key={m.id} data={src} m={m} me={ti} tiedTeams={none} games={bk.consolation} />)}</div>
              <div className="bcol late">{bk.ladder.map((m) => <Match key={m.id} data={src} m={m} me={ti} tiedTeams={none} games={bk.consolation} />)}</div>
            </div>
          </div>) : null}
      </div>
    </Chrome>
  );
}

function initialTeam(data) {
  const pick = (id) => data.teams.findIndex((t) => t.id === id);
  const fromPreview = window.__FT_TEAM__ != null ? pick(Number(window.__FT_TEAM__)) : -1;
  if (fromPreview >= 0) return fromPreview;
  const fromCookie = pick(Number(readCookie(TEAM_COOKIE)));
  if (fromCookie >= 0) return fromCookie;
  const first = data.teams.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
  return pick(first.id);
}

export default function FortuneTeller({ data, loadMap, live }) {
  const [boot, setBoot] = useState(null), [replay, setReplay] = useState(false);
  // After the regular season the page is the final standings; a map is only loaded to replay it.
  const over = !!data && (data.ready ? isFinal(data, data.trims[Math.max(0, Math.min(data.trims.length - 1, data.activeTrim ?? data.trims.length - 1))]) : !!(data.preview && data.preview.seasonOver));
  const [progress, setProgress] = useState(null);
  const counterRef = useRef(null);
  useEffect(() => {
    if (!data || !data.ready || (over && !replay)) return;
    const trim0 = Math.max(0, Math.min(data.trims.length - 1, data.activeTrim ?? data.trims.length - 1));
    const shared = typeof location !== "undefined" ? decodeShare(location.search, data, trim0, data.future.map((f) => f.digit)) : null;
    const t0 = shared && !shared.error ? shared.team : initialTeam(data);
    if (!counterRef.current) counterRef.current = makeCounter();
    const counter = counterRef.current;
    (async () => {
      const m = await loadMap(t0, (f) => setProgress(f));
      await counter.load(m);
      const G = data.games.length, fixed = data.trims[trim0].fixed, ok = shared && !shared.error;
      const path0 = ok ? shared.path : data.trims[trim0].defaultPath[t0].split("").map(Number);
      const settled0 = new Int8Array(G).fill(-1); for (let j = 0; j < fixed; j++) settled0[j] = path0[j];
      const pins0 = ok ? shared.pins : Int8Array.from(settled0);
      const counts = await counter.state(stateRequest(data, t0, trim0, pins0, settled0));
      setBoot({ ti: t0, map: m, shared, counts, counter });
    })().catch((e) => setBoot({ error: String(e) }));
  }, [data, replay]);
  if (data && over && !replay) return <FinalView data={data} onReplay={data.ready ? () => setReplay(true) : null} />;
  if (!data || (data.ready && !boot)) return <Chrome leagueName={data && data.leagueName}><div className="panel ftstate"><div className="placeholder"><b>Reading the tea leaves</b><span>{progress != null && progress < 1 ? `Loading the map · ${Math.round(progress * 100)}%` : "Loading every way the season can still go."}</span></div></div></Chrome>;
  if (!data.ready) return data.preview && data.preview.teams && data.preview.teams.length
    ? <Preview data={data} />
    : <Chrome leagueName={data.leagueName}><NotReady p={data.pipeline} /></Chrome>;
  if (boot.error) return <Chrome leagueName={data.leagueName}><div className="panel ftstate"><div className="placeholder"><b>Fortune Teller could not load</b><span>Reload the page to try again.</span></div></div></Chrome>;
  return <Live data={data} loadMap={loadMap} boot={boot} live={live} replay={replay ? { onExit: () => setReplay(false) } : null} />;
}

function Live({ data, loadMap, boot, live, replay }) {
  const n = data.teams.length, G = data.games.length, places = data.places;
  const trimIdx = Math.max(0, Math.min(data.trims.length - 1, data.activeTrim ?? data.trims.length - 1));
  const trim = data.trims[trimIdx];
  const [ti, setTi] = useState(boot.ti);
  const [map, setMap] = useState(boot.map);
  const counter = boot.counter;
  const [counts, setCounts] = useState(boot.counts);
  const [counting, setCounting] = useState(false);
  const reqSeq = useRef(0);
  const [loadingTeam, setLoadingTeam] = useState(false);
  const actual = useMemo(() => data.future.map((f) => f.digit), [data]);
  const defaultPath = (tIdx) => data.trims[trimIdx].defaultPath[tIdx].split("").map(Number);
  const freshPins = (p) => { const q = new Int8Array(G).fill(-1); for (let j = 0; j < trim.fixed; j++) q[j] = p[j]; return q; };
  const sh = boot.shared && !boot.shared.error ? boot.shared : null;
  const [path, setPath] = useState(() => (sh ? sh.path : defaultPath(boot.ti)));
  const [pins, setPins] = useState(() => (sh ? sh.pins : freshPins(defaultPath(boot.ti))));
  const [whatIf, setWhatIf] = useState(() => (sh ? sh.whatIf : !!replay));
  const [linkNote, setLinkNote] = useState(() => (boot.shared ? (boot.shared.error ? "bad" : "ok") : null));
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [tieOrders, setTieOrders] = useState(() => (sh ? sh.tieOrders : {}));
  const [stOpen, setStOpen] = useState(true);
  const [grown, setGrown] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true))); return () => cancelAnimationFrame(r); }, []);

  const mapRef = useRef(null), laneRef = useRef(null), snapRef = useRef(null);
  const snapshot = () => {
    const box = mapRef.current; if (!box || stillness()) return;
    const o = box.getBoundingClientRect(), rows = new Map(), heads = new Map();
    box.querySelectorAll(".week .game").forEach((el) => { const r = el.getBoundingClientRect(); rows.set(el.dataset.j, { top: r.top - o.top, left: r.left - o.left, width: r.width, el }); });
    box.querySelectorAll(".wkhead").forEach((el) => { heads.set(el.dataset.wk, el.getBoundingClientRect().top - o.top); });
    snapRef.current = { rows, heads };
  };

  const settledPins = useMemo(() => { const p = new Int8Array(G).fill(-1); for (let j = 0; j < trim.fixed; j++) p[j] = path[j]; return p; }, [path, trim, G]);
  // Counts come from the counter (a worker when it can run one): an ordinary click is one pass,
  // and nothing here waits on the main thread however large the map is.
  const want = stateRequest(data, ti, trimIdx, pins, settledPins);
  useEffect(() => {
    if (counts.key === want.key) return undefined;
    // The note appears only if counting outlasts 180 ms; an answer that arrives first cancels it.
    const seq = ++reqSeq.current; let settled = false;
    const slow = setTimeout(() => { if (!settled && seq === reqSeq.current) setCounting(true); }, 180);
    const finish = () => { settled = true; clearTimeout(slow); };
    const asked = typeof performance !== "undefined" ? performance.now() : 0;
    counter.state(want).then((c) => { finish(); if (window.__FT_DEBUG__) window.__FT_DEBUG__.push({ ...c.timing, roundTripMs: Math.round(performance.now() - asked), stale: seq !== reqSeq.current }); if (seq === reqSeq.current) { setCounts(c); setCounting(false); } }).catch(() => { finish(); if (seq === reqSeq.current) setCounting(false); });
    return () => clearTimeout(slow);
  }, [want.key]);
  const base = counts.base;
  const picks = useMemo(() => { let c = 0; for (let j = trim.fixed; j < G; j++) if (pins[j] >= 0) c++; return c; }, [pins, trim, G]);
  const cur = counts.cur;
  const myGames = data.games.filter((g, j) => j >= trim.fixed && (g.ai === ti || g.bi === ti));
  const winOut = counts.winOut, loseOut = counts.loseOut;
  // Every game played and every score known (the season's final week): nothing is left level or open.
  const decided = trim.fixed >= G;
  const flips = useMemo(() => data.games.map((g, j) => {
    const r = {};
    for (const d of [0, 1, 2]) { const p = path.slice(); p[j] = d; const b = decided ? definiteBlock(data, p, trim.pf, ti) : blockOf(data, p, ti); r[d] = { b, cls: classify(b, places), label: placeLabel(b) }; }
    return { r, relevant: ![0, 1, 2].every((d) => r[d].b.start === r[0].b.start && r[d].b.size === r[0].b.size) };
  }), [data, path, ti, places, decided, trim]);
  const oddsFor = useMemo(() => data.games.map((g, j) => [0, 1, 2].map((d) => ({ paths: cur.M[6 * j + 2 * d], pl: cur.M[6 * j + 2 * d + 1] }))), [data, cur]);
  const recNow = useMemo(() => { const rec = data.teams.map((t) => ({ w: t.w, l: t.l, t: t.t }));
    data.games.forEach((g, j) => { if (j >= trim.fixed) return; const d = path[j], a = rec[g.ai], b = rec[g.bi];
      if (d === 0) { a.t++; b.t++; } else if (d === 1) { a.w++; b.l++; } else { b.w++; a.l++; } }); return rec; }, [data, path, trim]);

  const pfNow = trim.pf;
  const st = useMemo(() => { const s0 = standings(data, path, pfNow, decided ? null : tieOrders); return decided ? flattenStandings(s0) : s0; }, [data, path, pfNow, tieOrders, decided]);
  const bk = brackets(st.rows.map((r) => r.ti), places, data.consolation);
  const tiedTeams = new Set(st.blocks.filter((b) => b.size > 1).flatMap((b) => b.members));
  const myRow = st.rows.find((r) => r.ti === ti);
  // Every team's simulated odds as of this week; once all is played, in or out on the path shown (a replay included).
  // Declared after the path and the standings it reads: above them it threw at render the moment every game was played.
  const simNow = decided
    ? (() => { const o = new Array(data.teams.length).fill(0); st.blocks.flatMap((b) => b.members).forEach((m, k) => { if (k < places) o[m] = 1; }); return o; })()
    : (trim && Array.isArray(trim.odds) ? trim.odds : null);
  const myBlock = { start: myRow.block.start, size: myRow.block.size };
  const myCls = classify(myBlock, places);
  let fin = base.total.slice(2), paths = base.total[0], odds = base.total[1] / paths;
  if (decided) { const place = myRow.block.start; fin = fin.map((_, p) => (p === place ? paths : 0)); odds = place < places ? 1 : 0; }
  const best = fin.findIndex((v) => v > 0); let worst = -1; fin.forEach((v, p) => { if (v > 0) worst = p; });
  const likely = fin.reduce((m, v, p) => (v > fin[m] ? p : m), 0);
  const maxFin = Math.max(...fin, 1e-12);
  const status = odds >= 1 - 1e-12 ? "Clinched" : odds <= 1e-12 ? "Eliminated" : "In the hunt";

  const fav = (g) => (g.pA >= g.pB ? 1 : 2);
  const [simple, setSimple] = useState(null);
  const simpleKey = `${ti}:${trimIdx}:${Array.from(settledPins).join("")}`;
  useEffect(() => {
    let cancel = false;
    const stored = trim.simplest && trim.simplest[ti];
    const asPlayed = Array.from(settledPins).every((d, j) => j >= trim.fixed || d === actual[j]);
    if (stored && asPlayed && !stored.timedOut) { setSimple({ key: simpleKey, res: { k: stored.k, set: stored.set } }); return () => { cancel = true; }; }
    const own = (j) => data.games[j].ai === ti || data.games[j].bi === ti;
    const order = data.games.map((g, j) => j).filter((j) => j >= trim.fixed).sort((a, b) => (own(b) - own(a)) || a - b);
    const prefer = data.games.map((g) => (g.ai === ti ? 1 : g.bi === ti ? 2 : (g.pA >= g.pB ? 1 : 2)));
    const go = (budget) => counter.simplest({ key: simpleKey, pins: settledPins, places, order, prefer, budgetMs: budget }).then(({ res }) => {
      if (cancel) return;
      if (res.timedOut && !counter.inWorker && budget < 3200) { setSimple({ key: simpleKey, res: { working: true } }); setTimeout(() => go(budget * 2), 300); return; }
      setSimple({ key: simpleKey, res });
    }).catch(() => {});
    const id = setTimeout(() => go(counter.inWorker ? 6000 : 400), counter.inWorker ? 0 : 650);
    return () => { cancel = true; clearTimeout(id); };
  }, [simpleKey, map]);
  const simpleRes = simple && simple.key === simpleKey ? simple.res : null;

  // The one game that matters most on the path being looked at: only unplayed games that
  // change the team's finish on this path qualify, so it can never be a greyed-out game.
  const biggest = useMemo(() => {
    const shareOf = (bk) => { if (bk.counts) { let s0 = 0; for (let i = 0; i < bk.size; i++) if (bk.start + i < places) s0 += bk.counts[i] / bk.total; return s0; } return Math.max(0, Math.min(bk.size, places - bk.start)) / bk.size; };
    const posOf = (bk) => { if (bk.counts) { let e = 0; for (let i = 0; i < bk.size; i++) e += (bk.start + i) * bk.counts[i] / bk.total; return e; } return bk.start + (bk.size - 1) / 2; };
    let top = null;
    data.games.forEach((g, j) => {
      if (j < trim.fixed || !flips[j].relevant) return;
      const res = [0, 1, 2].map((d) => ({ d, s: shareOf(flips[j].r[d].b), p: posOf(flips[j].r[d].b) }));
      const od = oddsFor[j].map((o) => (o.paths ? o.pl / o.paths : null)).filter((v) => v != null);
      const score = [Math.max(...res.map((r) => r.s)) - Math.min(...res.map((r) => r.s)), Math.max(...res.map((r) => r.p)) - Math.min(...res.map((r) => r.p)), od.length > 1 ? Math.max(...od) - Math.min(...od) : 0];
      const better = !top || score[0] > top.score[0] + 1e-12 || (Math.abs(score[0] - top.score[0]) <= 1e-12 && (score[1] > top.score[1] + 1e-12 || (Math.abs(score[1] - top.score[1]) <= 1e-12 && score[2] > top.score[2] + 1e-12)));
      if (!better) return;
      const best = res.slice().sort((x, y) => y.s - x.s || x.p - y.p)[0];
      const own = g.ai === ti || g.bi === ti;
      top = { j, score, root: own ? null : best.d === 0 ? "a tie" : data.teams[best.d === 1 ? g.ai : g.bi].name };
    });
    return top;
  }, [data, flips, oddsFor, trim, ti, places]);

  const series = counts.series;

  const jumps = useMemo(() => {
    const bestP = defaultPath(ti);
    const favP = data.games.map((g, j) => (j < trim.fixed ? path[j] : fav(g)));
    const ownP = (won) => data.games.map((g, j) => (j < trim.fixed ? path[j] : g.ai === ti ? (won ? 1 : 2) : g.bi === ti ? (won ? 2 : 1) : fav(g)));
    return [
      { id: "best", label: "Best path", path: bestP, icon: "M10 3l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.3l5-.7z" },
      { id: "fav", label: "ESPN projected wins", path: favP, icon: "M3 15l4-5 3 3 6-8" },
      (() => {
        const base0 = defaultPath(ti);
        if (!simpleRes || simpleRes.working) return { id: "simple", label: "Simplest path", path: base0, disabled: true, title: "Still working it out" };
        if (simpleRes.timedOut) return { id: "simple", label: "Simplest path", path: base0, disabled: true, title: "Too many routes to check on this device" };
        if (simpleRes.k === 0) return { id: "simple", label: "Simplest path", path: base0, disabled: true, title: "Already in the playoffs whatever happens" };
        if (!simpleRes.set) return { id: "simple", label: "Simplest path", path: base0, disabled: true, title: odds <= 1e-12 ? "No route to the playoffs is left" : "No route of six results or fewer guarantees a place" };
        const sp = base0.slice(), spins = freshPins(base0);
        for (const [j, d] of simpleRes.set) { sp[j] = d; spins[j] = d; }
        return { id: "simple", label: `Simplest path · ${simpleRes.k} ${simpleRes.k === 1 ? "result" : "results"}`, path: sp, pins: spins, icon: "M4 15c3 0 3-10 6-10s3 10 6 10" };
      })(),
      ...(myGames.length ? [{ id: "win", label: "You win out", path: ownP(true), icon: "M4 10l4 4 8-9" },
        { id: "lose", label: "You lose out", path: ownP(false), icon: "M3 5l5 5 3-3 6 8" }] : []),
    ];
  }, [data, ti, trimIdx, trim, path, myGames.length, simpleRes, odds]);
  const onJumps = new Set(jumps.filter((jp) => !jp.disabled && jp.path.every((d, j) => d === path[j]) && (!jp.pins || jp.pins.every((d, j) => d === pins[j]))).map((jp) => jp.id));
  const jump = (jp) => { if (jp.disabled) return; snapshot(); snapStandings(); setPath(jp.path.slice()); setPins(jp.pins ? Int8Array.from(jp.pins) : freshPins(jp.path)); setTieOrders({}); };
  // What this path means for the team, in words, under the place it gives.
  const tiedWith = myBlock.size > 1 ? ` · level with ${myBlock.size - 1}` : "";
  const pathOutcome = myCls === "in" ? `Clinches a playoff spot${tiedWith}` : myCls === "cut" ? `At the cut · level with ${myBlock.size - 1}, points decide` : `Misses the playoffs${tiedWith}`;
  const bestPath = jumps[0].path;

  const chooseTeam = async (id) => {
    const idx = data.teams.findIndex((t) => t.id === Number(id)); if (idx < 0 || idx === ti) return;
    writeCookie(TEAM_COOKIE, id);
    setLoadingTeam(true);
    try {
      const m = await loadMap(idx);
      await counter.load(m);
      const p = defaultPath(idx), q = freshPins(p);
      reqSeq.current++;
      const c = await counter.state(stateRequest(data, idx, trimIdx, q, Int8Array.from(q)));
      snapshot(); snapStandings();
      setMap(m); setTi(idx); setPath(p); setPins(q); setTieOrders({}); setWhatIf(false); setCounts(c);
    } catch (e) { /* keep the team that is showing */ } finally { setLoadingTeam(false); }
  };
  const setResult = (j, d) => { if (j < trim.fixed && !whatIf) return; snapshot(); snapStandings(); const p = path.slice(); p[j] = d; setPath(p); const q = Int8Array.from(pins); q[j] = d; setPins(q); };
  const sharePath = async () => {
    const qs = encodeShare({ teamId: data.teams[ti].id, path, pins, fixed: trim.fixed, whatIf, tieOrders, dataset: datasetTag(data), trim: trimIdx });
    const url = `${location.origin}${location.pathname}?${qs}`;
    try { await navigator.clipboard.writeText(url); } catch (e) { window.prompt("Copy this link", url); }
    setCopied(true); setTimeout(() => setCopied(false), 2200);
  };
  const clearPicks = () => { const q = Int8Array.from(pins); for (let j = trim.fixed; j < G; j++) q[j] = -1; setPins(q); };
  const toggleShowAll = () => { snapshot(); setShowAll(!showAll); };
  const toggleWhatIf = () => { snapshot(); snapStandings();
    if (whatIf) { const p = path.slice(); const q = Int8Array.from(pins); for (let j = 0; j < trim.fixed; j++) { p[j] = actual[j]; q[j] = actual[j]; } setPath(p); setPins(q); }
    setWhatIf(!whatIf); };

  // Rows slide from where they were drawn; rows that leave fade from their old place; the
  // line, beads and week stations retarget from wherever they are, so a quick second change
  // never jumps. Targets come from layout offsets, which ignore transforms still in flight.
  const lane = useRef({ disp: new Map(), from: new Map(), to: new Map(), exit: [], st: new Map(), t0: 0, raf: 0 });
  useLayoutEffect(() => {
    const box = mapRef.current, svg = laneRef.current; if (!box || !svg) return undefined;
    const snap = snapRef.current; snapRef.current = null;
    // Equal card heights are re-measured only when something that can change a card's height
    // changes (team, visible rows, What-if, width): measuring forces two layouts of the whole map.
    const rowsKey = [...box.querySelectorAll(".week .game")].map((g) => g.dataset.j).join(",");
    const heightKey = `${ti}|${showAll}|${whatIf}|${rowsKey}|${box.clientWidth}`;
    if (lane.current.heightKey !== heightKey) {
      lane.current.heightKey = heightKey;
      box.style.setProperty("--segh", "0px"); let tallest = 0;
      box.querySelectorAll(".week .game .switch").forEach((sw) => { if (sw.offsetHeight > tallest) tallest = sw.offsetHeight; });
      box.style.setProperty("--segh", tallest + "px");
    }
    const W = svg.getBoundingClientRect().width, TX = [W * 0.5, W * 0.19, W * 0.81];
    const weekEls = [...box.querySelectorAll(".week")];
    const layout = { rows: [], heads: [] };
    weekEls.forEach((wk) => { const head = wk.querySelector(".wkhead");
      layout.heads.push({ el: head, id: head.dataset.wk, now: head.dataset.now === "1", top: wk.offsetTop + head.offsetTop, h: head.offsetHeight });
      wk.querySelectorAll(".game").forEach((g) => { const sw = g.querySelector(".switch");
        layout.rows.push({ el: g, j: g.dataset.j, top: wk.offsetTop + g.offsetTop, y: wk.offsetTop + g.offsetTop + sw.offsetTop + sw.offsetHeight / 2,
          x: TX[+g.dataset.d], irr: g.classList.contains("irrelevant"), cls: g.dataset.cls, pin: g.dataset.pin === "1", played: g.dataset.played === "1" }); }); });
    if (snap) {
      layout.rows.forEach((r) => { r.el.getAnimations().forEach((a) => a.cancel()); const s = snap.rows.get(r.j);
        if (s) { const dy = s.top - r.top; if (Math.abs(dy) > 0.5) r.el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: DUR, easing: EASE }); }
        else r.el.animate([{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }], { duration: DUR, easing: EASE }); });
      layout.heads.forEach((h) => { h.el.getAnimations().forEach((a) => a.cancel()); const s = snap.heads.get(h.id); if (s == null) return; const dy = s - h.top;
        if (Math.abs(dy) > 0.5) h.el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: DUR, easing: EASE }); });
      const present = new Set(layout.rows.map((r) => r.j));
      snap.rows.forEach((s, j) => { if (present.has(j)) return; const gh = document.createElement("div"); gh.className = "ghost";
        gh.style.cssText = `left:${s.left}px;top:${s.top}px;width:${s.width}px`; gh.appendChild(s.el.cloneNode(true)); box.appendChild(gh);
        const a = gh.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-8px) scale(.985)" }], { duration: 240, easing: "ease-out", fill: "forwards" });
        a.onfinish = () => gh.remove(); });
    }
    const railLayer = svg.querySelector(".rails"), beadLayer = svg.querySelector(".beads"), line = svg.querySelector(".line"), glow = svg.querySelector(".glow"), stations = svg.querySelector(".stations");
    railLayer.innerHTML = TX.map((x) => `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="22" y2="${(box.offsetHeight - 4).toFixed(1)}"/>`).join("");
    const L = lane.current;
    const curve = (pts) => { if (pts.length < 2) return ""; let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let k = 1; k < pts.length; k++) { const a = pts[k - 1], b = pts[k], m = (b.y - a.y) / 2; d += ` C${a.x.toFixed(1)} ${(a.y + m).toFixed(1)} ${b.x.toFixed(1)} ${(b.y - m).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`; } return d; };
    const bead = (p) => `<g class="bead ${p.cls}${p.pin ? " pin" : ""}${p.played ? " played" : ""}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})" opacity="${(p.a ?? 1).toFixed(2)}">${p.pin ? '<circle class="ring" r="9.5"/>' : ""}${p.played ? '<rect x="-5" y="-5" width="10" height="10" transform="rotate(45)"/>' : '<circle r="5.5"/>'}</g>`;
    const station = (s) => `<g class="st${s.now ? " now" : ""}" transform="translate(0 ${s.y.toFixed(1)})"><line x1="0" x2="${W.toFixed(1)}"/><rect x="${(W / 2 - 5).toFixed(1)}" y="-5" width="10" height="10" transform="rotate(45 ${(W / 2).toFixed(1)} 0)"/></g>`;
    const paint = (pts, exits, sts) => { const d = curve(pts); line.setAttribute("d", d); glow.setAttribute("d", d);
      beadLayer.innerHTML = exits.map(bead).join("") + pts.map(bead).join(""); stations.innerHTML = sts.map(station).join(""); };
    const to = new Map(); layout.rows.forEach((r) => { to.set(r.j, { x: r.x, y: r.y, cls: r.irr ? "same" : r.cls, pin: r.pin, played: r.played }); });
    const stTo = layout.heads.map((h) => ({ id: h.id, now: h.now, y: h.top + h.h / 2 }));
    const frame = (now) => {
      const t = Math.min(1, (now - L.t0) / DUR), e = ease(t), pts = [];
      L.to.forEach((tg, j) => { const f = L.from.get(j); const p = { ...tg, x: f.x + (tg.x - f.x) * e, y: f.y + (tg.y - f.y) * e, a: f.a + (1 - f.a) * e }; L.disp.set(j, p); pts.push(p); });
      pts.sort((a, b) => a.y - b.y);
      const sts = L.stTo.map((s) => { const f = L.stFrom.get(s.id) ?? s.y; const y = f + (s.y - f) * e; L.st.set(s.id, y); return { ...s, y }; });
      paint(pts, L.exit.map((x) => ({ ...x, a: (x.a ?? 1) * (1 - e) })), sts);
      if (t < 1) L.raf = requestAnimationFrame(frame); else { L.raf = 0; L.exit = []; }
    };
    if (!snap) {
      if (L.raf) { cancelAnimationFrame(L.raf); L.raf = 0; }
      L.disp = new Map([...to].map(([j, p]) => [j, { ...p, a: 1 }])); L.to = to; L.exit = [];
      L.st = new Map(stTo.map((s) => [s.id, s.y])); L.stTo = stTo;
      paint([...L.disp.values()].sort((a, b) => a.y - b.y), [], stTo);
      if (!L.introDone && !stillness() && layout.rows.length) {
        L.introDone = true;
        layout.rows.forEach((r, k) => r.el.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
          { duration: 460, delay: Math.min(k * 34, 520), easing: "cubic-bezier(.22,.7,.3,1)", fill: "backwards" }));
        try { const len = line.getTotalLength();
          line.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }], { duration: 900, delay: 120, easing: "cubic-bezier(.45,0,.2,1)", fill: "backwards" });
          glow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: 500, fill: "backwards" });
          beadLayer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 380, fill: "backwards" }); } catch (e) { /* drawn without the intro */ }
      } else L.introDone = true;
    } else {
      L.from = new Map(); to.forEach((tg, j) => { const d = L.disp.get(j); L.from.set(j, d ? { x: d.x, y: d.y, a: d.a ?? 1 } : { x: tg.x, y: tg.y - 10, a: 0 }); });
      L.exit = []; L.disp.forEach((d, j) => { if (!to.has(j)) L.exit.push({ ...d }); });
      L.disp = new Map([...L.disp].filter(([j]) => to.has(j)));
      L.stFrom = new Map(L.st); L.stTo = stTo;
      L.to = to; L.t0 = performance.now(); if (!L.raf) L.raf = requestAnimationFrame(frame);
    }
    let rz = 0; const ro = new ResizeObserver(() => { if (rz) return; rz = requestAnimationFrame(() => { rz = 0; if (L.raf) return;
      const W2 = svg.getBoundingClientRect().width, TX2 = [W2 * 0.5, W2 * 0.19, W2 * 0.81], pts = [], sts = [];
      box.querySelectorAll(".week").forEach((wk) => { const head = wk.querySelector(".wkhead"); const y = wk.offsetTop + head.offsetTop + head.offsetHeight / 2;
        sts.push({ id: head.dataset.wk, now: head.dataset.now === "1", y }); L.st.set(head.dataset.wk, y);
        wk.querySelectorAll(".game").forEach((g) => { const sw = g.querySelector(".switch"), p = L.disp.get(g.dataset.j); if (!p) return;
          p.x = TX2[+g.dataset.d]; p.y = wk.offsetTop + g.offsetTop + sw.offsetTop + sw.offsetHeight / 2; pts.push(p); }); });
      paint(pts.sort((a, b) => a.y - b.y), [], sts); }); });
    ro.observe(box);
    return () => { ro.disconnect(); if (rz) cancelAnimationFrame(rz); };
  });
  useEffect(() => () => { if (lane.current.raf) cancelAnimationFrame(lane.current.raf); }, []);

  // --- standings: a row lifts and follows the pointer, neighbours make room, and it settles on drop
  const stRef = useRef(null), stSnap = useRef(null);
  const tds = (tr) => [...tr.children];
  const setY = (tr, y, trans) => tds(tr).forEach((td) => { td.style.transition = trans || ""; td.style.transform = y ? `translateY(${y}px)` : ""; });
  const snapStandings = () => { const box = stRef.current; if (!box || stillness()) return; const m = new Map();
    box.querySelectorAll("tr[data-tid]").forEach((el) => m.set(el.dataset.tid, el.getBoundingClientRect().top)); stSnap.current = m; };
  useLayoutEffect(() => {
    const snap = stSnap.current; stSnap.current = null; const box = stRef.current; if (!snap || !box) return;
    const trs = [...box.querySelectorAll("tr[data-tid]")];
    trs.forEach((tr) => { tds(tr).forEach((td) => td.getAnimations().forEach((a) => a.cancel())); setY(tr, 0); tr.classList.remove("dragging"); });
    trs.forEach((tr) => { const s0 = snap.get(tr.dataset.tid); if (s0 == null) return; const dy = s0 - tr.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) tds(tr).forEach((td) => td.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 300, easing: EASE })); });
  });
  const moveInBlock = (block, from, to) => { const ids = block.members.map((m) => data.teams[m].id); const [x] = ids.splice(from, 1); ids.splice(to, 0, x); setTieOrders((o) => ({ ...o, [block.key]: ids })); };
  const nudge = (block, from, to) => { snapStandings(); moveInBlock(block, from, to); };
  const winRef = useRef(null), conRef = useRef(null), fboardRef = useRef(null);
  // Values over the finish columns never collide: where two would, the smaller share gives way.
  useDeclutter(fboardRef, ".fv", (el) => Number(el.dataset.v) || 0, null, [fin.join(",")]);
  useLinks(winRef, [["sf1", "final", "w"], ["sf2", "final", "w"], ["sf1", "third", "l"], ["sf2", "third", "l"]]);
  useLinks(conRef, [["c5", "p5", "w"], ["c7", "p5", "w"], ["c5", "p7", "l"], ["c9", "p7", "w"], ["c7", "p9", "l"], ["c9", "p9", "l"]]);

  const teamOptions = data.teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ value: t.id, label: t.name, logo: t.logo }));
  const weeks = [...new Set(data.games.map((g) => g.week))];
  const thisWeek = weeks.find((wk) => data.games.some((g) => g.week === wk && g.i >= trim.fixed));
  const tiesOnPath = st.blocks.filter((b) => b.size > 1);
  // Tie groups alternate between two ambers, so neighbouring groups never read as one.
  const toneOf = new Map(tiesOnPath.map((b, k) => [b.key, k % 2 ? "b" : "a"]));
  const toneOfTeam = new Map(tiesOnPath.flatMap((b) => b.members.map((m) => [m, toneOf.get(b.key)])));
  const ruleName = { H2H_RECORD: "Head-to-head record", TOTAL_POINTS_SCORED: "Total points for", INTRA_DIVISION_RECORD: "Division record", TOTAL_POINTS_AGAINST: "Points against" }[data.seedingRule] || "Total points for";
  // A move within a tie is offered only if the league's rules can produce the result.
  const canMove = (b, from, to) => { if (!b.orders) return true; const o = b.members.slice(); const [x] = o.splice(from, 1); o.splice(to, 0, x); return b.orders.some((r) => r.join() === o.join()); };

  const GameNode = ({ g, j }) => {
    const f = flips[j]; const settled = j < trim.fixed, locked = settled && !whatIf, mine = g.ai === ti || g.bi === ti;
    const changed = settled && path[j] !== actual[j], fut = data.future[j], chosen = f.r[path[j]];
    const side = (d) => {
      const r = f.r[d], od = oddsFor[j][d], cls = f.relevant ? r.cls : "same", on = path[j] === d;
      const share = od.paths ? od.pl / od.paths : 0, isBest = bestPath[j] === d && !on;
      const tix = d === 1 ? g.ai : d === 2 ? g.bi : -1;
      const sub = d === 0 ? (settled ? (fut.hp === fut.ap ? "Final" : "") : `${winPct(g.pT)} chance`)
        : settled ? fmtPts(d === 1 ? fut.hp : fut.ap) : `${recStr(recNow[tix])} · ${winPct(d === 1 ? g.pA : g.pB)} to win`;
      return (
        <button key={d} type="button" role="radio" aria-checked={String(on)} disabled={locked}
          className={`seg ${cls}${d === 0 ? " tie" : d === 2 ? " b" : " a"}${isBest ? " best" : ""}${tix === ti ? " self" : ""}`}
          onClick={() => setResult(j, d)} title={locked ? "Played. Switch on What-if to change it." : ""}
          aria-label={`${d === 0 ? "Tie" : data.teams[tix].name + " win"}: ${r.label}`}>
          <span className="fill" />
          {isBest ? <span className="besttag">Best</span> : null}
          {d === 0 ? <span className="tieglyph" aria-hidden="true">=</span> : <span className="lg"><TeamLogo src={data.teams[tix].logo} alt="" /></span>}
          <span className="nm">{d === 0 ? "Tie" : data.teams[tix].name}</span>
          <span className="sub">{sub}</span>
          <span className="res"><span className="rl"><b>{r.label}</b><em>{od.paths ? pct(od.pl, od.paths) : "–"}</em></span><span className="meter"><i style={{ transform: `scaleX(${share})` }} /></span></span>
        </button>
      );
    };
    return (
      <div className={"game" + (f.relevant ? "" : " irrelevant") + (mine ? " mine" : "")} data-j={j} data-d={path[j]} data-cls={f.relevant ? chosen.cls : "same"}
        data-pin={!settled && pins[j] >= 0 ? "1" : "0"} data-played={settled ? "1" : "0"}>
        <div className="gmeta">
          {mine ? <span className="tag mine">Your game</span> : null}
          {biggest && biggest.j === j && f.relevant ? <span className="tag big">Biggest game on this path{biggest.root ? <React.Fragment> · root for <strong>{biggest.root}</strong></React.Fragment> : null}</span> : null}
          {!settled
            ? <span className="tag proj">Projected winner <strong>{g.projA >= g.projB ? g.aName : g.bName}</strong> {Math.max(g.projA, g.projB).toFixed(1)}–{Math.min(g.projA, g.projB).toFixed(1)}</span>
            : <span className="tag final">{fut.hp === fut.ap ? "Final · tied " : <React.Fragment>Final · <strong>{fut.hp > fut.ap ? g.aName : g.bName}</strong> won </React.Fragment>}{fmtPts(Math.max(fut.hp, fut.ap))}–{fmtPts(Math.min(fut.hp, fut.ap))}</span>}
          {changed ? <span className="tag wif">What-if</span> : null}
          {!settled && pins[j] >= 0 ? <span className="tag pin">Set by you</span> : null}
          {!f.relevant ? <span className="tag same">Doesn't affect you</span> : null}
        </div>
        <div className="switch" role="radiogroup" aria-label={`${g.aName} v ${g.bName}`}>{DIGITS.map(side)}</div>
      </div>
    );
  };


  const tname = data.teams[ti].name;
  return (
    <Chrome leagueName={data.leagueName}>
      {(() => {
        // What the pipeline is doing while a map is showing: an update, a rebuild, the season's end, a failed update, or a newer map.
        const pl = (live && live.pipeline) || data.pipeline, thru = trim.thru, real = data.source === "build";
        let note = null;
        if (replay) note = { kind: "done", text: "Replaying the regular season. With What-if on, change any result to see where everyone would have finished.", action: { label: "Back to the final standings", fn: replay.onExit } };
        else if (live && live.changed) note = { kind: "fresh", text: "A newer map is ready.", reload: true };
        else if (real && pl && pl.state === "updating") note = { kind: "busy", text: `Week ${pl.lastSettled} is in and the map is being updated. You are seeing it through week ${thru}.` };
        else if (real && pl && pl.state === "building") note = { kind: "busy", text: "The map is being rebuilt after a change to the league's results. You are seeing the previous version." };
        else if (real && pl && pl.state === "season-over") note = { kind: "done", text: "The regular season is over: this is how it finished. Switch on What-if to replay any of it." };
        else if (real && pl && pl.state === "failed") note = { kind: "warn", text: `This week's update did not finish. You are seeing the map through week ${thru}.` };
        return note ? <div className={"ftnote " + note.kind} role="status"><span>{note.text}</span>{note.action ? <button type="button" className="ftbtn" onClick={note.action.fn}>{note.action.label}</button> : note.reload ? <button type="button" className="ftbtn" onClick={() => location.reload()}>Reload</button> : null}</div> : null;
      })()}
      <div className="pickrow"><TeamSelect label="My team" value={data.teams[ti].id} placeholder="Select your team" options={teamOptions} onChange={chooseTeam} />
        {loadingTeam ? <span className="chip loadchip"><i />Loading map</span> : counting ? <span className="chip loadchip"><i />Counting</span> : null}</div>

      <div className={"hero" + (loadingTeam ? " busy" : "")}>
        <div className="panel oddspanel ftin" style={{ "--d": "40ms" }}>
          <div className="panelhead"><span className="t">Playoff odds</span><span className="count">every way it can still go</span></div>
          <div className="gaugewrap">
            <Gauge value={odds} cls={oddsCls(odds)} />
            <div className={"gaugeval " + oddsCls(odds)}><b><Share value={odds} /></b><span><strong>{paths.toLocaleString()}</strong> {paths === 1 ? "path" : "paths"}</span></div>
          </div>
          <div className="chips">
            <Pop k={status}><span className={"chip st " + (status === "Clinched" ? "in" : status === "Eliminated" ? "out" : "hunt")}><i />{status}</span></Pop>
            {winOut != null && winOut >= 1 - 1e-12 && status !== "Clinched" ? <span className="chip own"><i />Controls own destiny</span> : null}
          </div>
          <div className="stats">
            <div className="stat"><span>Best finish</span><b><Pop k={"b" + best + ti}>{best >= 0 ? ordinal(best + 1) : "–"}</Pop></b></div>
            <div className="stat"><span>Most likely</span><b><Pop k={"m" + likely + ti}>{ordinal(likely + 1)}</Pop></b></div>
            <div className={"stat" + (worst >= places ? " out" : "")}><span>Worst finish</span><b><Pop k={"w" + worst + ti}>{worst >= 0 ? ordinal(worst + 1) : "–"}</Pop></b></div>
            <div className={"stat wide " + (winOut == null ? "" : oddsCls(winOut))}><span>If you win out</span><b>{winOut == null ? "–" : <Share value={winOut} />}</b></div>
            <div className={"stat wide " + (loseOut == null ? "" : oddsCls(loseOut))}><span>If you lose out</span><b>{loseOut == null ? "–" : <Share value={loseOut} />}</b></div>
          </div>
        </div>
        <div className="panel finpanel ftin" style={{ "--d": "120ms" }}>
          <div className="panelhead"><span className="t">Where you finish</span><span className="count">share of every remaining path</span></div>
          <div className="fboard" style={{ "--n": n }} ref={fboardRef}>
            <div className="fzones">
              <div className="fz po" style={{ gridColumn: `1 / span ${places}` }}><span className="zl">Playoffs</span><b><Share value={odds} /></b><span className="zs">Places 1–{places}</span></div>
              <div className="fz co" style={{ gridColumn: `${places + 1} / -1` }}><span className="zl">{data.consolation ? "Consolation" : "Out"}</span><b><Share value={1 - odds} /></b><span className="zs">Places {places + 1}–{n}</span></div>
            </div>
            <div className="fchart">
              <span className="fbg po" style={{ gridColumn: `1 / span ${places}` }} />
              <span className="fbg co" style={{ gridColumn: `${places + 1} / -1` }} />
              {fin.map((v, p) => (
                <span key={p} className={"fcol" + (p < places ? " po" : "") + (v === 0 ? " zero" : "") + (p === likely ? " likely" : "")} style={{ gridColumn: p + 1 }} title={`${ordinal(p + 1)}: ${pct(v, paths)}`}>
                  <span className="fv" data-v={v / paths}>{pct(v, paths)}</span>
                  <span className="fbar"><i style={{ transform: `scaleY(${grown && v > 0 ? Math.max(0.03, v / maxFin) : 0})`, transitionDelay: `${p * 38}ms` }} /></span>
                </span>
              ))}
              <span className="fcut" style={{ gridColumn: `${places + 1}` }} aria-hidden="true" />
            </div>
            <div className="faxis">{fin.map((v, p) => <span key={p} className={(p < places ? "po" : "") + (p === likely ? " likely" : "")} title={p === likely ? "Most likely finish" : undefined}>{ordinal(p + 1)}</span>)}</div>
            <OddsByWeek points={[...espnPoints(data.espnHistory, data.teams[ti].id, data.trims[0].thru), ...series.map((q) => { const k = data.trims.findIndex((t) => t.thru === q.week); const f = q.kind === "played" && k >= 0 ? finalOdds(data, data.trims[k]) : null; return f ? { ...q, v: f[ti] } : q; })]} k={`${ti}:${trimIdx}`} nowLabel={decided ? "Final" : "Now"} />
          </div>
        </div>
      </div>

      <div className="sechead ftin" style={{ "--d": "200ms" }}><span className="t">The map</span><span className="rule" /><span className="count">weeks {weeks[0]}–{weeks[weeks.length - 1]} · {cur.total[0] === 1 ? "1 path" : `${cur.total[0].toLocaleString()} paths`}</span></div>
      <div className="ctlbar ftin" style={{ "--d": "240ms" }}>
        {trim.fixed < data.games.length ? (
        <div className="jumps" role="group" aria-label="Jump to a path">
          <span className="jlab">Jump to</span>
          {jumps.map((jp) => (
            <button key={jp.id} type="button" className={"jump" + (onJumps.has(jp.id) ? " on" : "")} aria-pressed={String(onJumps.has(jp.id))} disabled={!!jp.disabled} title={jp.title || ""} onClick={() => jump(jp)}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d={jp.icon || "M4 15c3 0 3-10 6-10s3 10 6 10"} /></svg>{jp.label}</button>
          ))}
        </div>
        ) : null}
        <div className="pathsum">
          <span className={"psum " + myCls}><small>This path</small><b><Pop k={"p" + placeLabel(myBlock)}>{placeLabel(myBlock)}</Pop></b><em>{pathOutcome}</em></span>
          {picks ? <span className={"psum " + oddsCls(cur.total[1] / cur.total[0])}><small>With your {picks === 1 ? "result" : picks + " results"}</small><b><Share value={cur.total[1] / cur.total[0]} /></b><em>vs {pct(base.total[1], paths)} overall</em></span> : null}
          <span className="pathbtns">
            <button className="ftbtn share" type="button" onClick={sharePath}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 12l4-4M7 9.5 5.2 11.3a2.6 2.6 0 0 0 3.7 3.7L10.7 13M13 10.5l1.8-1.8a2.6 2.6 0 0 0-3.7-3.7L9.3 7" /></svg>{copied ? "Link copied" : "Share this path"}</button>
            <button className="ftbtn" type="button" onClick={clearPicks} disabled={!picks}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>Clear selections</button>
          </span>
        </div>
        <div className="toggles">
          <label className={"tog" + (showAll ? " on" : "")}><button className={"ftsw" + (showAll ? " on" : "")} role="switch" type="button" aria-checked={String(showAll)} onClick={toggleShowAll}><i /></button>Games that don't affect you</label>
          <label className={"tog" + (whatIf ? " on" : "") + (trim.fixed ? "" : " off")} title={trim.fixed ? "" : "Nothing in the simulated weeks has been played yet"}>
            <button className={"ftsw" + (whatIf ? " on" : "")} role="switch" type="button" aria-checked={String(whatIf)} disabled={!trim.fixed} onClick={toggleWhatIf}><i /></button>What-if</label>
        </div>
      </div>

      {linkNote ? <div className={"linknote " + linkNote}><span>{linkNote === "ok" ? "Opened from a shared link." : "That link was made for a different week or dataset, so this is your best path instead."}</span>
        <button type="button" className="ftbtn" onClick={() => setLinkNote(null)}>Dismiss</button></div> : null}
      <div className="ftgrid">
        <div className="map" ref={mapRef}>
          <svg className="lane" ref={laneRef} aria-hidden="true">
            <defs><linearGradient id="linegrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" className="ls0" /><stop offset="100%" className="ls1" /></linearGradient></defs>
            <g className="rails" /><g className="stations" /><path className="glow" /><path className="line" /><g className="beads" />
          </svg>
          <div className="lanekey" aria-hidden="true"><span>A</span><span>Tie</span><span>B</span></div>
          {weeks.map((wk) => {
            const wg = data.games.filter((g) => g.week === wk);
            const played = wg.every((g) => g.i < trim.fixed), now = wk === thisWeek;
            const hid = wg.filter((g) => !flips[g.i].relevant).length;
            return (
              <section className={"week" + (now ? " now" : "") + (played ? " played" : "")} key={wk}>
                <div className="wkhead" data-wk={wk} data-now={now ? "1" : "0"}>
                  <span className="wkno"><small>Week</small><b>{wk}</b></span>
                  <span className="wkchips">
                    {now ? <span className="chip now"><i />This week</span> : null}
                    <span className={"chip" + (played ? " played" : "")}>{played ? (whatIf ? "Played · What-if" : "Played") : "To play"}</span>
                    <span className="chip n">{wg.length} games</span>
                    {!showAll && hid ? <span className="chip hid">{hid} hidden</span> : null}
                  </span>
                  <span className="wkrule" />
                </div>
                {wg.map((g) => (!flips[g.i].relevant && !showAll ? null : <React.Fragment key={g.i}>{GameNode({ g, j: g.i })}</React.Fragment>))}
              </section>
            );
          })}
        </div>

        <aside className="panel stpanel ftin" style={{ "--d": "300ms" }}>
          <div className="panelhead"><span className="t">Final standings</span><span className="count">on this path</span>
            <button className="sttoggle" type="button" aria-expanded={String(stOpen)} aria-label={stOpen ? "Hide standings" : "Show standings"} onClick={() => setStOpen(!stOpen)}><i /></button></div>
          <div className="stbody" hidden={!stOpen}>
            {tiesOnPath.length ? (
              <div className="tiecall">
                <div className="tctop"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4v12M16 4v12M4 10h12" /></svg><b>{tiesOnPath.length === 1 ? "1 tie" : tiesOnPath.length + " ties"} on record</b></div>
                <div className="tcchips"><span className="chip">Broken by <strong>{ruleName.toLowerCase()}</strong></span><span className="chip">Points still to be scored</span><span className="chip drag"><i aria-hidden="true" />Reorder with the arrows</span></div>
              </div>) : null}
            <ScrollBox>
            <table className="datatable ftst">
              <thead><tr><th className="c-rank"><span className="lbl">Place</span></th><th className="col-team"><span className="lbl">Team</span></th><th className="c-key"><span className="lbl">Record</span></th><th className="c-num"><span className="lbl">Points now</span></th><th className="c-num"><span className="lbl">Sim%</span></th></tr></thead>
              <tbody ref={stRef}>
                {st.blocks.map((b) => {
                  const tied = b.size > 1, tone = toneOf.get(b.key);
                  const rows = b.members.map((m, k) => {
                    const r = st.rows.find((x) => x.ti === m), seed = b.start + k + 1, t = data.teams[m];
                    const lead = k > 0 ? pfNow[m] - pfNow[b.members[k - 1]] : null;
                    return (
                      <React.Fragment key={m}>
                        <tr className={(m === ti ? "me" : "") + (tied ? " tie" : "") + (seed <= places ? " po" : "")} data-tid={t.id} data-block={tied ? b.key : undefined} data-tone={tied ? tone : undefined}>
                          <td className="c-rank">{tied
                            ? <span className="tplace">
                                
                                <span className="tpill">T{b.start + 1}</span>
                                <span className="moves">
                                  <button className="mv" type="button" aria-label={`Move ${t.name} up within the tie`} disabled={k === 0 || !canMove(b, k, k - 1)} onClick={() => nudge(b, k, k - 1)}><i /></button>
                                  <button className="mv dn" type="button" aria-label={`Move ${t.name} down within the tie`} disabled={k === b.size - 1 || !canMove(b, k, k + 1)} onClick={() => nudge(b, k, k + 1)}><i /></button>
                                </span>
                              </span>
                            : seed <= 3 ? <span className={"medal " + ["g", "s", "b"][seed - 1]} title={ordinal(seed)}>{seed}</span> : seed}</td>
                          <td className="col-team"><div className="stname"><TeamLogo src={t.logo} alt="" className="tklogo" /><div className="stnamewrap"><b>{t.name}</b></div></div></td>
                          <td className="c-key">{recStr(r.record)}</td>
                          <td className="c-num">{fmtPts(pfNow[m])}{lead != null ? <small className={"gap " + (lead >= 0 ? "up" : "dn")}>{lead >= 0 ? "+" : "−"}{fmtPts(Math.abs(lead))}</small> : null}</td>
                          <td className="c-num">{simCell(simNow ? simNow[m] : null)}</td>
                        </tr>
                        {seed === places && seed < n ? <tr className="porow" aria-hidden="true"><td colSpan={5}><span><i />Playoffs</span></td></tr> : null}
                      </React.Fragment>
                    );
                  });
                  return tied ? (
                    <React.Fragment key={b.key}>
                      <tr className="tierow" data-tone={tone}><td colSpan={5}><b>Tied at {recStr(st.rows.find((x) => x.ti === b.members[0]).record)}</b><span>{b.size} teams</span><span>Places {b.start + 1}–{b.start + b.size}</span></td></tr>
                      {rows}
                    </React.Fragment>) : rows;
                })}
              </tbody>
            </table>
            </ScrollBox>
          </div>
        </aside>
      </div>

      <div className="sechead"><span className="t">If this path happens</span><span className="rule" /><span className="count">seeded from the final standings</span></div>
      <div className={"bkrow" + (bk.consolation.length ? "" : " solo")}>
        <div className="panel">
          <div className="panelhead"><span className="t">Playoffs</span><span className="count">top {places}</span></div>
          <div className="board ftfade" key={"w" + ti} ref={winRef}><svg className="bklinks" aria-hidden="true" />
            <div className="bcol">{bk.winners.map((m) => <Match key={m.id} data={data} m={m} me={ti} tiedTeams={toneOfTeam} games={bk.winners} />)}</div>
            <div className="bcol late">{bk.later.map((m) => <Match key={m.id} data={data} m={m} me={ti} tiedTeams={toneOfTeam} games={bk.winners} />)}</div>
          </div>
        </div>
        {bk.consolation.length ? (
          <div className="panel">
            <div className="panelhead"><span className="t">Consolation ladder</span><span className="count">places {places + 1}–{n}</span></div>
            <div className="board ftfade" key={"c" + ti} ref={conRef}><svg className="bklinks" aria-hidden="true" />
              <div className="bcol">{bk.consolation.map((m) => <Match key={m.id} data={data} m={m} me={ti} tiedTeams={toneOfTeam} games={bk.consolation} />)}</div>
              <div className="bcol late">{bk.ladder.map((m) => <Match key={m.id} data={data} m={m} me={ti} tiedTeams={toneOfTeam} games={bk.consolation} />)}</div>
            </div>
          </div>) : null}
      </div>
    </Chrome>
  );
}
