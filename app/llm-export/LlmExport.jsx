import ToolControls from "../shared/ToolControls.jsx";
import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { PALETTES, BASE_CSS, BACKDROP, TEAM_COOKIE } from "../../src/ui.js";
import SettingsMenu from "../shared/SettingsMenu.jsx";
import TeamSelect from "../shared/TeamSelect.jsx";
import Instructions from "../shared/Instructions.jsx";
import { attachVScroll } from "../../src/vscroll.js";
import { applyMyTeam } from "./myteam.js";
import { compactExport } from "./compact.js";
import { buildPrompt } from "./prompt.js";
import {
  formatExport, lineHtml, lineDiff, sectionMap, formatBytes, downloadName,
} from "./format.js";

/* ==========================================================================
 * LLM Data Export
 *
 * One league-wide document arrives from the server. The reader's team and the
 * compact form are applied here, so switching either is instant and the page
 * never shows text that differs from what gets copied or downloaded.
 * ========================================================================== */

const RATE = 0.7;          // px per ms — the site's disclosure rate
const PROMPT_CLAMP = 300;  // px of prompt shown before it is opened
const COARSE = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(pointer:coarse)").matches : false;

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const m = new RegExp("(?:^|; )" + name + "=([^;]*)").exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : "";
}

function writeTeamCookie(id) {
  try {
    document.cookie = TEAM_COOKIE + "=" + encodeURIComponent(id == null ? "" : id)
      + "; path=/; max-age=31536000; samesite=lax";
  } catch (e) { /* a locked-down profile keeps the choice for this visit only */ }
}

function zone() {
  const z = readCookie("eft_tz");
  return z && z !== "device" ? z : undefined;
}

function whenText(isoString) {
  if (!isoString) return "unknown";
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
      timeZone: zone(),
    }).format(new Date(isoString));
  } catch (e) { return new Date(isoString).toLocaleString(); }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the selection route */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

/* ==========================================================================
 * CSS — the Trade Analyzer's type and spacing steps, so the two tools read as
 * one family.
 * ========================================================================== */
const CSS = `
:root {
  --fs-micro: 9px; --fs-small: 11px; --fs-base: 13px; --fs-lg: 16px;
  --sp-1: 6px; --sp-2: 14px; --sp-3: 26px; --sp-4: clamp(36px, 5vw, 58px);
  --ease-out: cubic-bezier(.22,.7,.3,1); --ease-io: cubic-bezier(.5,0,.2,1);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing:border-box; }
button { -webkit-tap-highlight-color:transparent; font-family:inherit; }
.wrap { display:flex; flex-direction:column; }

/* --- tool header --------------------------------------------------------- */
.toolhead { display:flex; align-items:center; gap:18px; padding:0 0 var(--sp-2);
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

/* --- section headers ------------------------------------------------------ */
.sechead { display:flex; flex-wrap:wrap; align-items:center; gap:10px var(--sp-2);
  margin:var(--sp-4) 0 var(--sp-3); }
.sechead::before { content:""; width:9px; height:9px; background:var(--accent);
  transform:rotate(45deg); flex:none; }
.sechead .t { font-size:clamp(15px,2.2vw,21px); font-weight:900; letter-spacing:.18em;
  text-transform:uppercase; line-height:1.1; flex:0 1 auto; min-width:0; overflow-wrap:anywhere;
  background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
  -webkit-background-clip:text; background-clip:text;
  color:transparent; -webkit-text-fill-color:transparent; }
.sechead .rule { flex:1 1 32px; min-width:32px; height:1px;
  background:linear-gradient(90deg,var(--line-2),transparent); }
/* The subtitle drops to its own line rather than pushing past the edge. */
.sechead .count { flex:0 1 auto; max-width:100%; font-size:var(--fs-micro); font-weight:900;
  letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); line-height:1.3;
  overflow-wrap:anywhere; }

/* --- buttons -------------------------------------------------------------- */
.minibtn { display:inline-flex; align-items:center; justify-content:center; gap:7px;
  background:none; border:1px solid var(--line-2); color:var(--ink-2); cursor:pointer;
  font-size:var(--fs-micro); font-weight:900; letter-spacing:.14em; text-transform:uppercase;
  padding:9px 14px; min-height:34px; white-space:nowrap;
  transition:border-color .16s ease, color .16s ease, background .16s ease; }
.minibtn svg { width:13px; height:13px; flex:none; }
.minibtn:hover { border-color:var(--accent); color:var(--accent); }
.minibtn.go { border-color:var(--accent); color:var(--accent); }
.minibtn.go:hover { background:var(--accent); color:var(--field); }
.minibtn.done, .minibtn.done:hover { border-color:var(--accent); background:var(--accent);
  color:var(--field); }
.minibtn.fail, .minibtn.fail:hover { border-color:var(--flag); color:var(--flag); background:none; }
.minibtn:focus-visible, .seg button:focus-visible, .mapkey:focus-visible,
.more:focus-visible { outline:1px solid var(--accent); outline-offset:2px; }


/* --- your team ------------------------------------------------------------ */
.teampick { display:grid; grid-template-columns:minmax(0,380px) minmax(0,1fr);
  gap:var(--sp-2) var(--sp-3); align-items:center; }
.teamfacts { display:flex; flex-wrap:wrap; gap:0; min-width:0; }
.fact { padding:2px 16px 2px 0; margin-right:16px; border-right:1px solid var(--line); min-width:0; }
.fact:last-child { border-right:0; margin-right:0; }
.fact .k { display:block; font-size:var(--fs-micro); font-weight:900; letter-spacing:.14em;
  text-transform:uppercase; color:var(--ink-3); }
.fact .v { display:block; font-size:var(--fs-lg); font-weight:900; color:var(--ink);
  font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  max-width:260px; }
.fact .v.acc { color:var(--accent); }
.callout { display:flex; align-items:flex-start; gap:10px; min-width:0; padding:10px 12px;
  border:1px solid var(--signal); background:var(--signal-soft); }
.callout svg { width:16px; height:16px; flex:none; margin-top:1px; color:var(--signal); }
.callout b { display:block; font-size:var(--fs-micro); font-weight:900; letter-spacing:.14em;
  text-transform:uppercase; color:var(--signal); margin-bottom:2px; }
.callout span { display:block; font-size:12.5px; line-height:1.5; color:var(--ink-2); }
@media (max-width:760px) {
  .teampick { grid-template-columns:1fr; }
  .teamfacts, .stats { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:12px 0; }
  .fact { margin-right:12px; padding-right:12px; }
  .fact:nth-child(3n), .fact:nth-last-child(2), .fact:last-child { border-right:0; margin-right:0; }
  .fact:last-child { grid-column:1 / -1; }
  .fact { display:flex; flex-direction:column; justify-content:space-between; }
  .fact .v { max-width:100%; }
}
@media (max-width:400px) {
  .fact { margin-right:8px; padding-right:8px; }
  .fact .k { letter-spacing:.08em; }
}

/* --- panel toolbars ------------------------------------------------------- */
.ctlrow { display:flex; align-items:center; flex-wrap:wrap; gap:10px var(--sp-2);
  margin-bottom:var(--sp-2); }
.ctlrow .grow { flex:1 1 auto; }
.stats { display:flex; flex-wrap:wrap; gap:10px 0; margin:var(--sp-2) 0 0; padding:10px 0 0;
  border-top:1px solid var(--line); min-width:0; }
.stats .fact .v { font-size:var(--fs-base); }
.stats .fact.file { flex:1 1 220px; min-width:0; }
.stats .fact.file .v { font:700 12px/1.45 var(--mono); color:var(--sky); white-space:normal;
  overflow-wrap:anywhere; max-width:none; }
.actions { display:flex; gap:8px; flex:none; }
@media (max-width:560px) {
  .actions { width:100%; }
  .actions .minibtn { flex:1 1 0; }
}

/* --- pills: what a prompt or a file carries ----------------------------- */
.pillrow { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-width:0; }
.pillrow + .pillrow { margin-top:8px; }
.plab { flex:none; width:74px; font-size:var(--fs-micro); font-weight:900; letter-spacing:.14em;
  text-transform:uppercase; color:var(--ink-3); }
.pill { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:5px 9px;
  border:1px solid var(--line-2); background:var(--panel-2); color:var(--ink-2);
  font-size:var(--fs-micro); font-weight:900; letter-spacing:.1em; text-transform:uppercase;
  line-height:1.3; overflow-wrap:anywhere; }
.pill::before { content:""; flex:none; width:5px; height:5px; background:currentColor;
  transform:rotate(45deg); }
.pill.ok::before { background:var(--accent); }
.pill.me { color:var(--accent); border-color:currentColor; background:var(--accent-glow); }
.pill.warn { color:var(--signal); border-color:currentColor; background:var(--signal-soft); }
.pill.off { color:var(--ink-3); background:none; border-style:dashed;
  text-decoration:line-through; text-decoration-thickness:1px; }
.pill.off::before { background:none; border:1px solid currentColor; }
.pill b { color:inherit; font-weight:900; font-variant-numeric:tabular-nums; }
@media (max-width:560px) { .plab { width:100%; } }

/* --- prompt --------------------------------------------------------------- */
.promptbox { position:relative; overflow:hidden; border:1px solid var(--line);
  background:var(--inset); }
.pv { padding:16px 18px 18px; font-size:13px; line-height:1.65; color:var(--ink-2);
  max-width:88ch; overflow-wrap:anywhere; }
.pv p { margin:0 0 10px; }
.pv p.lead { color:var(--ink); font-size:14px; }
.pv h4 { display:flex; align-items:center; gap:10px; margin:20px 0 9px; font-size:var(--fs-micro);
  font-weight:900; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); }
.pv h4::before { content:""; width:6px; height:6px; flex:none; background:currentColor;
  transform:rotate(45deg); }
.pv h4::after { content:""; flex:1; height:1px; background:linear-gradient(90deg,var(--line-2),transparent); }
.pv ul, .pv ol { list-style:none; margin:0 0 10px; padding:0; }
.pv li { position:relative; margin:0 0 6px; padding-left:18px; }
.pv ul li::before { content:""; position:absolute; left:3px; top:.62em; width:5px; height:5px;
  border:1px solid var(--ink-3); transform:rotate(45deg); }
.pv ol li { padding-left:30px; }
.pv ol li::before { content:attr(data-n); position:absolute; left:0; top:0; width:22px;
  text-align:right; font-weight:900; color:var(--accent); font-variant-numeric:tabular-nums; }
.pv .key { font:700 12px var(--mono); color:var(--sky); }
.pv code { font:12px var(--mono); color:var(--sky); }
.pv .q { color:var(--ink); font-weight:700; }
.pv strong.q { font-weight:800; }
.pv .sep { color:var(--ink-3); }
.promptbox.shut::after { content:""; position:absolute; left:0; right:0; bottom:0; height:96px;
  background:linear-gradient(180deg, transparent, var(--inset) 88%); pointer-events:none; }
.more { display:flex; align-items:center; justify-content:center; gap:8px; width:100%;
  margin-top:-1px; padding:10px; background:none; border:1px solid var(--line);
  color:var(--sky); cursor:pointer; font-size:var(--fs-micro); font-weight:900;
  letter-spacing:.14em; text-transform:uppercase; }
.more:hover { border-color:var(--sky); }
.more i { width:7px; height:7px; border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor; transform:translateY(-2px) rotate(45deg);
  transition:transform .2s var(--ease-out); }
.more[aria-expanded="true"] i { transform:translateY(2px) rotate(-135deg); }

/* --- version switch ------------------------------------------------------- */
.seg { display:inline-flex; border:1px solid var(--line-2); flex:none; }
.seg button { background:none; border:0; cursor:pointer; padding:7px 14px; min-height:34px;
  color:var(--ink-3); font-size:var(--fs-micro); font-weight:900; letter-spacing:.14em;
  text-transform:uppercase; display:inline-flex; align-items:baseline; gap:7px; }
.seg button + button { border-left:1px solid var(--line-2); }
.seg button small { font-size:var(--fs-micro); font-weight:800; letter-spacing:.06em;
  color:var(--ink-3); text-transform:none; }
.seg button[aria-pressed="true"] { background:var(--accent); color:var(--field); }
.seg button[aria-pressed="true"] small { color:var(--field); opacity:.75; }

/* --- file map: the file drawn to scale ------------------------------------ */
.map { margin:var(--sp-2) 0 var(--sp-2); }
.mapbar { display:flex; height:14px; gap:2px; }
.mapbar i { display:block; min-width:3px; background:var(--line-2);
  transition:background .16s ease, transform .16s var(--ease-out); cursor:pointer;
  transform-origin:50% 100%; }
.mapbar i:nth-child(even) { background:var(--ink-3); opacity:.55; }
.mapbar i.on { background:var(--accent); opacity:1; transform:scaleY(1.45); }
.mapkeys { display:flex; flex-wrap:wrap; gap:4px 2px; margin-top:10px; }
.mapkey { display:inline-flex; align-items:baseline; gap:6px; background:none;
  border:1px solid transparent; cursor:pointer; padding:4px 8px; color:var(--ink-2);
  font:12px/1.2 var(--mono); }
.mapkey small { font:800 var(--fs-micro)/1 ui-sans-serif,system-ui,sans-serif;
  letter-spacing:.08em; color:var(--ink-3); font-variant-numeric:tabular-nums; }
.mapkey:hover { border-color:var(--line-2); }
.mapkey.on { border-color:var(--accent); color:var(--accent); }
.mapkey.empty { color:var(--ink-3); }

/* --- the viewer ----------------------------------------------------------- */
.viewer { position:relative; border:1px solid var(--line); background:var(--inset); }
.viewer .vbar { top:6px; bottom:6px; right:4px; }
.jsonview { position:relative; max-height:min(72vh, 780px); overflow-y:auto; overflow-x:hidden;
  padding:12px 12px 16px 0;
  font:12px/1.62 var(--mono); color:var(--ink-2); --gut:48px; --ind:1ch;
  /* One rule down the gutter, painted once, rather than a pseudo-element on
     every line: a few thousand of those, plus a CSS counter recalculated on
     every style change, is most of what made a long file scroll badly. */
  background-image:linear-gradient(90deg, transparent calc(var(--gut) + 6px),
    var(--line) calc(var(--gut) + 6px), var(--line) calc(var(--gut) + 7px),
    transparent calc(var(--gut) + 7px)); }
.jline { position:relative; white-space:pre-wrap; contain:layout paint;
  overflow-wrap:anywhere; word-break:normal;
  padding-left:calc(var(--gut) + 12px + (var(--d) * var(--ind) + 2ch)); text-indent:-2ch; }
.jnum { position:absolute; left:0; width:var(--gut); text-align:right; text-indent:0;
  color:var(--ink-3); opacity:.55; font-variant-numeric:tabular-nums;
  user-select:none; -webkit-user-select:none; }
.jk { color:var(--sky); }
.js { color:var(--accent); }
.jn { color:var(--gold); }
.jl { color:var(--signal); }
.jp { color:var(--ink-3); }
@media (max-width:560px) {
  .jsonview { font-size:11px; --gut:34px; --ind:.5ch; max-height:68vh; }
}

.toolfoot { margin-top:var(--sp-2); padding:10px 0 4px; text-align:center;
  border-top:1px solid var(--line); }
.toolfoot .gh { display:inline-flex; align-items:center; gap:7px; color:var(--ink-3);
  font-size:10px; text-transform:uppercase; letter-spacing:.16em; font-weight:900;
  text-decoration:none; }
.toolfoot .gh::before { content:""; width:5px; height:5px; background:currentColor;
  transform:rotate(45deg); }
.toolfoot .gh:hover { color:var(--accent); }
.loadbox { display:flex; align-items:center; justify-content:center; gap:11px;
  padding:var(--sp-4) var(--sp-2); color:var(--ink-3); font-size:var(--fs-small);
  font-weight:900; letter-spacing:.14em; text-transform:uppercase; }
.loadbox i { width:9px; height:9px; background:var(--accent); transform:rotate(45deg);
  animation:pulse 1.25s var(--ease-io) infinite; }
@keyframes pulse { 0%,100% { opacity:.25; } 50% { opacity:1; } }
html.stillness .loadbox i { animation:none; opacity:.7; }
`;

const INSTRUCTIONS = [
  ["01", "What this is",
    "One file holding everything about this league (rules and scoring, every roster, standings, the schedule, the best available players and the NFL calendar) and a prompt that tells an AI chat assistant how to read it. With both, the assistant can answer questions about your team as if it had read every page of the league."],
  ["02", "Choose your team",
    "The file marks it and the prompt is written from its side. It is the same choice the home page uses, so changing it here changes it there too. Without one, the assistant asks you first."],
  ["03", "Full or compact",
    "Full carries everything. Compact keeps what a weekly decision needs at well under half the size. Pick compact if your assistant says the file is too long, or seems to forget parts of it."],
  ["04", "Prompt first, then the file",
    "Paste the prompt into a new chat and attach the downloaded file to the same message. If the assistant cannot take files, paste the prompt, then copy the data and paste it straight after."],
  ["05", "Export again when things change",
    "The file is a snapshot of the moment it was made. After waivers run, a trade goes through or injury news breaks, come back for a fresh one."],
  ["06", "What is never in it",
    "Owner names, passwords, ESPN sign-in details, and pending waiver claims for any team, yours included."],
];

const COPY_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="8.5" y="8.5" width="11" height="11" /><path d="M15.5 8.5V4.5h-11v11h4" />
  </svg>
);
const DONE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
const DOWNLOAD_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
  </svg>
);

const ALERT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.5l9 16H3z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.4" r=".6" fill="currentColor" />
  </svg>
);

/* Inline markdown in the prompt: **bold** and `code`, with quoted values
   picked out too. What is copied is the markdown itself. */
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|("[^"\n]+")/g;
function inlineParts(text, keyBase) {
  const out = [];
  let last = 0;
  let n = 0;
  text.replace(INLINE, (m, bold, code, quoted, at) => {
    if (at > last) out.push(text.slice(last, at));
    if (bold) out.push(<strong key={keyBase + "b" + n++} className="q">{bold}</strong>);
    else if (code) out.push(<code key={keyBase + "c" + n++}>{code}</code>);
    else out.push(<span key={keyBase + "q" + n++} className="q">{quoted}</span>);
    last = at + m.length;
    return m;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The prompt's markdown, laid out: headings, field lists and numbered steps. */
function PromptView({ text }) {
  const blocks = [];
  let list = null;
  const flush = () => { if (list) { blocks.push(list); list = null; } };
  text.split("\n").forEach((line) => {
    const bullet = /^- (.*)$/.exec(line);
    const step = /^(\d+)\. (.*)$/.exec(line);
    if (bullet) {
      if (!list || list.kind !== "ul") { flush(); list = { kind: "ul", items: [] }; }
      list.items.push({ text: bullet[1] });
    } else if (step) {
      if (!list || list.kind !== "ol") { flush(); list = { kind: "ol", items: [] }; }
      list.items.push({ n: step[1], text: step[2] });
    } else {
      flush();
      if (!line.trim()) return;
      const head = /^#{1,6} (.*)$/.exec(line);
      if (head) blocks.push({ kind: "h", text: head[1] });
      else blocks.push({ kind: "p", text: line });
    }
  });
  flush();
  let firstP = true;
  return (
    <div className="pv">
      {blocks.map((b, i) => {
        if (b.kind === "h") return <h4 key={i}>{b.text}</h4>;
        if (b.kind === "p") {
          const lead = firstP; firstP = false;
          return <p key={i} className={lead ? "lead" : ""}>{inlineParts(b.text, i + ":")}</p>;
        }
        const Tag = b.kind;
        return (
          <Tag key={i}>
            {b.items.map((it, j) => {
              const kv = b.kind === "ul"
                ? /^(`[^`]+`(?: \/ `[^`]+`)*): (.*)$/.exec(it.text) : null;
              return (
                <li key={j} data-n={it.n}>
                  {kv ? (
                    <React.Fragment>
                      <span className="key">{kv[1].replace(/`/g, "")}</span><span className="sep"> &mdash; </span>
                      {inlineParts(kv[2], i + "." + j + ":")}
                    </React.Fragment>
                  ) : inlineParts(it.text, i + "." + j + ":")}
                </li>
              );
            })}
          </Tag>
        );
      })}
    </div>
  );
}

/** What each version carries, and for compact, what it leaves out. */
function contentsOf(version, doc) {
  const fa = doc && doc.freeAgents ? doc.freeAgents.players.length : 0;
  if (version === "compact") {
    return {
      has: ["Rules", "Rosters", "This week", "Games left", `${fa} free agents`, "NFL next 2 weeks"],
      lacks: ["Weekly points", "Ownership", "Injury notes", "Past results", "History"],
    };
  }
  return {
    has: ["Rules", "Rosters", "This week", "Schedule", "Weekly points", "Ownership",
      "Injury notes", `${fa} free agents`, "NFL calendar", "History"],
    lacks: [],
  };
}

/** A copy button whose label says what just happened, then settles back. */
function CopyButton({ label, getText, className = "" }) {
  const [state, setState] = useState("idle");
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(await getText());
    setState(ok ? "done" : "fail");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };
  return (
    <button type="button" onClick={onClick} aria-live="polite"
      className={"minibtn " + className + (state === "done" ? " done" : state === "fail" ? " fail" : "")}>
      {state === "done" ? DONE_ICON : COPY_ICON}
      {state === "done" ? "Copied" : state === "fail" ? "Couldn\u2019t copy" : label}
    </button>
  );
}

export default function LlmExport() {
  const preview = typeof window !== "undefined" ? window.__LLM_PREVIEW__ : null;
  const [data, setData] = useState(preview || null);
  const fetchedAt = useRef(Date.now());
  const [loading, setLoading] = useState(!preview);
  const [failed, setFailed] = useState(false);
  const [theme, setTheme] = useState(() =>
    (typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-theme") : "dark") || "dark");
  const [tzTick, setTzTick] = useState(0);
  const [teamId, setTeamId] = useState(() => {
    const fromPreview = typeof window !== "undefined" ? window.__LLM_TEAM__ : null;
    return fromPreview != null ? fromPreview : (Number(readCookie(TEAM_COOKIE)) || null);
  });
  const [version, setVersion] = useState("full");
  const [promptOpen, setPromptOpen] = useState(false);
  const [active, setActive] = useState(null);
  const viewRef = useRef(null);
  const viewBarRef = useRef(null);
  const promptRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.__LE_SEEN__ = data ? {
      ready: Boolean(data.ready), teams: data.export ? data.export.teams.length : 0,
      source: preview ? "inlined" : "fetched",
    } : { ready: false, teams: 0, source: preview ? "inlined" : "pending" };
  }, [data, preview]);

  useEffect(() => {
    if (preview) return;
    let live = true;
    fetch("/api/llm-export", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j) => { if (live) { setData(j); fetchedAt.current = Date.now(); setLoading(false); } })
      .catch(() => { if (live) { setFailed(true); setLoading(false); } });
    return () => { live = false; };
  }, [preview]);

  useEffect(() => {
    const on = () => setTzTick((n) => n + 1);
    window.addEventListener("tzchange", on);
    return () => window.removeEventListener("tzchange", on);
  }, []);

  const base = data && data.ready ? data.export : null;
  const teamKnown = base && teamId != null && base.teams.some((t) => t.teamId === teamId);
  const mine = useMemo(() => (base ? applyMyTeam(base, teamKnown ? teamId : null) : null),
    [base, teamId, teamKnown]);
  const full = useMemo(() => (mine ? formatExport(mine) : ""), [mine]);
  const compactDoc = useMemo(() => (mine ? compactExport(mine) : null), [mine]);
  const compact = useMemo(() => (compactDoc ? formatExport(compactDoc) : ""), [compactDoc]);
  const doc = version === "compact" ? compactDoc : mine;
  const text = version === "compact" ? compact : full;
  const lines = useMemo(() => (text ? text.replace(/\n$/, "").split("\n") : []), [text]);
  /* The viewer is patched, never replaced: only lines that changed are built, and lines
     after a change that moved them are renumbered. Replacing it whole re-parsed thousands
     of lines to change a handful when the reader picked another team. What is copied or
     downloaded comes from the text, never from this view, so it cannot be affected. */
  const shown = useRef({ pane: null, lines: null });
  useLayoutEffect(() => {
    const pane = viewRef.current; if (!pane) return;
    const prev = shown.current.pane === pane ? shown.current.lines : null, d = lineDiff(prev, lines);
    if (d.rebuild) pane.innerHTML = lines.map(lineHtml).join("");
    else {
      const kids = pane.children, oldMid = prev.length - d.p - d.s, newMid = lines.length - d.p - d.s;
      for (let i = 0; i < oldMid; i++) pane.removeChild(kids[d.p]);
      const add = lines.slice(d.p, d.p + newMid).map((l, k) => lineHtml(l, d.p + k)).join("");
      if (add) { if (d.p < kids.length) kids[d.p].insertAdjacentHTML("beforebegin", add); else pane.insertAdjacentHTML("beforeend", add); }
      if (newMid !== oldMid) for (let i = d.p + newMid; i < lines.length; i++) { const el = kids[i]; el.id = "jl-" + i; el.firstChild.textContent = String(i + 1); }
    }
    shown.current = { pane, lines };
  }, [lines]);
  const sections = useMemo(() => (doc ? sectionMap(doc, text) : []), [doc, text]);
  const bytes = useMemo(() => new TextEncoder().encode(text).length, [text]);
  const fullBytes = useMemo(() => new TextEncoder().encode(full).length, [full]);
  const compactBytes = useMemo(() => new TextEncoder().encode(compact).length, [compact]);
  const prompt = useMemo(() => (doc ? buildPrompt(doc) : ""), [doc]);

  const picked = mine && mine.myTeam;
  const teamsUi = (data && data.teamsUi) || [];

  const logoOf = (id) => (teamsUi.find((t) => t.id === id) || {}).logo || null;

  const pickTeam = (value) => {
    const id = Number(value) || null;
    setTeamId(id);
    writeTeamCookie(id);
  };

  /* Which section the viewer is showing, from where its first line sits. Section positions
     are measured once after each change, after the frame has painted (so layout is already
     done), and a scroll only compares against them: reading positions on the spot forced a
     layout of every line, on every change and every scroll event. */
  const sectionTops = useRef([]);
  const onViewScroll = useCallback(() => {
    const pane = viewRef.current;
    if (!pane || !sections.length) return;
    const top = pane.scrollTop + 10;
    let current = null;
    sections.forEach((s, i) => { const t = sectionTops.current[i]; if (t != null && t <= top) current = s.key; });
    setActive(current);
  }, [sections]);
  useEffect(() => {
    const pane = viewRef.current; if (!pane) return undefined;
    let timer = 0;
    const raf = requestAnimationFrame(() => { timer = setTimeout(() => {
      sectionTops.current = sections.map((s) => { if (s.line < 0) return null; const el = pane.querySelector("#jl-" + s.line); return el ? el.offsetTop : null; });
      onViewScroll();
    }, 0); });
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [lines, sections, onViewScroll]);
  // Re-attached when the text changes: the pane's content is replaced whole, so
  // the bar has a new length to measure.
  useEffect(() => {
    if (!viewRef.current || !viewBarRef.current || !lines.length) return undefined;
    return attachVScroll(viewRef.current, viewBarRef.current);
  }, [lines]);

  const jump = (s) => {
    const pane = viewRef.current;
    if (!pane || s.line < 0) return;
    const el = pane.querySelector("#jl-" + s.line);
    if (!el) return;
    pane.scrollTo({ top: Math.max(0, el.offsetTop - 6), behavior: document.documentElement.classList.contains("stillness") ? "auto" : "smooth" });
    setActive(s.key);
  };

  /* A file is handed over at the moment it is asked for, so the data behind it
     is refetched first if it has aged: somebody who left the page open through
     a Sunday should not download a file describing the morning. The route
     rebuilds a stale export before answering, so this is the whole chain. */
  const refresh = async () => {
    if (preview || !data) return null;
    if (Date.now() - fetchedAt.current < 45000) return null;
    try {
      const fresh = await (await fetch("/api/llm-export?fresh=1", { credentials: "same-origin" })).json();
      if (fresh && fresh.ready) {
        fetchedAt.current = Date.now();
        setData(fresh);
        return fresh;
      }
    } catch (e) { /* keep what is on screen */ }
    return null;
  };

  const textFrom = (payload) => {
    if (!payload || !payload.ready) return text;
    const mineNow = applyMyTeam(payload.export, teamKnown ? teamId : null);
    return formatExport(version === "compact" ? compactExport(mineNow) : mineNow);
  };

  const download = async () => {
    const fresh = await refresh();
    const body = fresh ? textFrom(fresh) : text;
    const blob = new Blob([body], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName(data.leagueName || (base && base.league.name), new Date(), zone());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  /* The prompt's height is stated outright; the animation only decorates it. */
  const togglePrompt = () => {
    const box = promptRef.current;
    const next = !promptOpen;
    const still = COARSE || document.documentElement.classList.contains("stillness");
    if (box && !still && box.animate) {
      const from = box.getBoundingClientRect().height;
      const to = next ? box.scrollHeight : PROMPT_CLAMP;
      box.animate([{ height: from + "px" }, { height: to + "px" }],
        { duration: Math.min(900, Math.abs(to - from) / RATE), easing: "cubic-bezier(.22,.7,.3,1)" });
    }
    setPromptOpen(next);
  };

  const styleTag = (
    <style dangerouslySetInnerHTML={{ __html: `${PALETTES}\n${BASE_CSS}\n${CSS}` }} />
  );

  const Header = (
    <div className="toolhead">
      <a className="toolmark homelink" href="/" aria-label="Back to home">
        <svg className="mark" viewBox="0 0 1000 150" role="img" aria-label="ESPN Fantasy Tools">
          <text x="500" y="74" textAnchor="middle" textLength="980"
            lengthAdjust="spacingAndGlyphs" fontSize="86" fontWeight="900" letterSpacing="-2"
            fontFamily="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
            <tspan className="m1">ESPN</tspan>
            <tspan className="m2"> FANTASY TOOLS</tspan>
          </text>
          <path className="rule" d="M10 100 H990" />
          <path className="rulelive" d="M10 100 H360" />
          <text x="500" y="137" textAnchor="middle" fontSize="30" fontWeight="700"
            letterSpacing="14" fill="var(--ink-3)"
            fontFamily="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
            LEAGUE HQ
          </text>
        </svg>
      </a>
      <div className="toolid">
        <p className="eyebrow">LLM Data Export</p>
        <div className="toolleague">{(data && data.leagueName) || "League"}</div>
      </div>
      <div className="toolctl">
        <ToolControls steps={INSTRUCTIONS} label="How to use the LLM Data Export" theme={theme} onTheme={setTheme} />
      </div>
    </div>
  );

  const Help = null;   // the help dialog now comes with ToolControls

  const Foot = (
    <React.Fragment>
      <div className="grow" />
      <div className="pageaction">
        <a className="pagebtn" href="/">&larr; Back to home</a>
      </div>
      <div className="toolfoot">
        <a className="gh" href="https://github.com/shortcutsbin-netizen"
          target="_blank" rel="noopener noreferrer">GitHub - shortcutsbin-netizen</a>
      </div>
    </React.Fragment>
  );

  if (loading || failed || !base) {
    return (
      <React.Fragment>
        {styleTag}
        <div dangerouslySetInnerHTML={{ __html: BACKDROP }} />
        <div className="wrap">
          {Header}
          {failed || (data && !data.ready) ? (
            <div className="placeholder" style={{ marginTop: "40px" }}>
              <b>No league data yet</b>
              <span>
                The export is assembled from the league pull. If that has not run yet, whoever
                runs the league can start it from Site Configuration.
              </span>
            </div>
          ) : (
            <div className="loadbox"><i />Packing the league</div>
          )}
          {Foot}
        </div>
        {Help}
      </React.Fragment>
    );
  }

  const standingRow = picked ? base.standings.find((s) => s.teamId === picked.teamId) : null;
  const contents = contentsOf(version, doc);
  const fileName = downloadName(data.leagueName || base.league.name, new Date(), zone());
  void tzTick;

  return (
    <React.Fragment>
      {styleTag}
      <div dangerouslySetInnerHTML={{ __html: BACKDROP }} />
      <div className="wrap">
        {Header}

        <div className="sechead"><span className="t">Your team</span><span className="rule" /></div>
        <div className="panel">
          <div className="teampick">
            <TeamSelect label="My team" value={picked ? picked.teamId : ""}
              placeholder="Select your team"
              options={[{ value: "", label: "No team", logo: null }].concat(
                base.teams.slice().sort((a, b) => a.name.localeCompare(b.name))
                  .map((t) => ({ value: t.teamId, label: t.name, logo: logoOf(t.teamId) })))}
              onChange={(v) => pickTeam(v)} />
            {picked ? (
              <div className="teamfacts">
                {picked.standing ? (
                  <div className="fact"><span className="k">Standing</span>
                    <span className="v">{picked.standing.replace(/ of \d+$/, "")}</span></div>
                ) : null}
                {picked.record ? (
                  <div className="fact"><span className="k">Record</span>
                    <span className="v">{picked.record}</span></div>
                ) : null}
                {standingRow && standingRow.playoffOdds ? (
                  <div className="fact"><span className="k">Playoff odds</span>
                    <span className="v">{standingRow.playoffOdds}</span></div>
                ) : null}
                {picked.thisWeek ? (
                  <div className="fact"><span className="k">Week {base.about.currentWeek} opponent</span>
                    <span className="v acc">{picked.thisWeek.opponent}</span></div>
                ) : null}
              </div>
            ) : (
              <div className="callout">
                {ALERT_ICON}
                <span>
                  <b>No team chosen</b>
                  The file still covers the whole league, and the prompt tells the assistant to
                  ask which team is yours before anything else.
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="sechead"><span className="t">Prompt</span><span className="rule" />
          <span className="count">For the {version} file</span></div>
        <div className="panel">
          <div className="ctlrow">
            <div className="pillrow" style={{ flex: "1 1 300px" }}>
              <span className="pill ok">Any assistant</span>
              <span className="pill ok">Every field explained</span>
              <span className="pill ok">Ground rules</span>
              <span className="pill ok">Briefing first</span>
              {picked
                ? <span className="pill me">For {picked.team}</span>
                : <span className="pill warn">Asks for your team</span>}
            </div>
            <div className="actions">
              <CopyButton label="Copy prompt" getText={() => prompt} className="go" />
            </div>
          </div>
          <div ref={promptRef} className={"promptbox" + (promptOpen ? "" : " shut")}
            style={{ height: promptOpen ? "auto" : PROMPT_CLAMP + "px" }}>
            <PromptView text={prompt} />
          </div>
          <button type="button" className="more" aria-expanded={promptOpen} onClick={togglePrompt}>
            {promptOpen ? "Show less" : "Show the whole prompt"}<i />
          </button>
        </div>

        <div className="sechead"><span className="t">League data</span><span className="rule" />
          <span className="count">As of {whenText(base.about.generatedAt)}</span></div>
        <div className="panel">
          <div className="ctlrow">
            <div className="seg" role="group" aria-label="Export version">
              <button type="button" aria-pressed={version === "full"} onClick={() => setVersion("full")}>
                Full <small>{formatBytes(fullBytes)}</small>
              </button>
              <button type="button" aria-pressed={version === "compact"} onClick={() => setVersion("compact")}>
                Compact <small>{formatBytes(compactBytes)}</small>
              </button>
            </div>
            <div className="grow" />
            <div className="actions">
              <CopyButton label="Copy" getText={async () => textFrom(await refresh())} />
              <button type="button" className="minibtn go" onClick={download}>
                {DOWNLOAD_ICON}Download
              </button>
            </div>
          </div>

          <div className="pillrow">
            <span className="plab">Includes</span>
            {contents.has.map((c) => <span key={c} className="pill ok">{c}</span>)}
          </div>
          {contents.lacks.length ? (
            <div className="pillrow">
              <span className="plab">Leaves out</span>
              {contents.lacks.map((c) => <span key={c} className="pill off">{c}</span>)}
            </div>
          ) : null}

          <div className="stats">
            <div className="fact"><span className="k">Size</span><span className="v">{formatBytes(bytes)}</span></div>
            <div className="fact"><span className="k">Lines</span>
              <span className="v">{(text.split("\n").length - 1).toLocaleString()}</span></div>
            <div className="fact"><span className="k">Week</span><span className="v">{base.about.currentWeek}</span></div>
            <div className="fact file"><span className="k">Downloads as</span><span className="v">{fileName}</span></div>
          </div>

          <div className="map">
            <div className="mapbar" aria-hidden="true">
              {sections.map((s) => (
                <i key={s.key} className={active === s.key ? "on" : ""}
                  style={{ flex: `${Math.round(Math.max(s.share, 0.002) * 10000)} 1 0` }}
                  title={s.key} onClick={() => jump(s)} />
              ))}
            </div>
            <div className="mapkeys">
              {sections.map((s) => (
                <button key={s.key} type="button"
                  className={"mapkey" + (active === s.key ? " on" : "") + (s.bytes <= 4 ? " empty" : "")}
                  onClick={() => jump(s)}>
                  {s.key}<small>{s.bytes <= 4 ? "empty" : formatBytes(s.bytes)}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="viewer vwrap">
            <div ref={viewRef} className="jsonview vscroll scrollpane" tabIndex={0}
              aria-label="League data as JSON" onScroll={onViewScroll} />
            <div className="vbar" hidden ref={viewBarRef}><div className="vbar-thumb" /></div>
          </div>
        </div>

        {Foot}
      </div>
      {Help}
    </React.Fragment>
  );
}
