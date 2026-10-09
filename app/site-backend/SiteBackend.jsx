import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ToolControls from "../shared/ToolControls.jsx";
import TeamSelect from "../shared/TeamSelect.jsx";
import ScrollBox from "../shared/ScrollBox.jsx";
import { noteBrake, pollDelay } from "../shared/brake.js";
import { Ctx, Blocks, Feed, KV, Heartbeat, Dot, Time, useNow } from "./blocks.jsx";
import { setZone, readZone, localMidnight, clockText, num, toMs } from "./format.js";

/* ==========================================================================
 * Site Backend
 *
 * How the site is running, read as stored: nothing here changes the site or
 * starts any work. Each tab is one request, answered by the site log with every
 * panel's one-line summary plus the bodies of the panels that are open, so a tab
 * of closed panels is the cheapest poll there is. Refreshes every 15 seconds
 * while visible; pauses after four hours without a tap.
 * ========================================================================== */

const API = "/apps/site-backend/api";
const POLL_MS = 15000;
const IDLE_MS = 4 * 3600 * 1000;
const SEEN_KEY = "eft_sb_seen";

const HELP = [
  [1, "Overview", "The whole site at a glance. The word at the top says whether anything needs you, and the trace under it is the minute schedule's heartbeat. Every panel starts closed with a one-line summary; tap it, or its chip in the row above, to open it. Needs attention lists anything amber or red, with a button that opens the panel explaining it."],
  [2, "A tab for every page", "Each page of the site has its own tab: first the panels about that page alone, then its settings, the datasets it reads and what they are built from, the requests it makes, who visited, and its part of the log."],
  [3, "Activity", "The site's log. Visits and sign-ins name the team chosen on that browser, and nothing else about a visitor. Each hour's status reports fold into one line; tap it to open them. Filter by page, kind, team, severity and time, or search. Each season keeps its own log."],
  [4, "Data Layer", "Every dataset the site keeps, raw and derived: how fresh it is against its interval, its parts and size, its last fetch and failure, and what it is built from; the coordinators' work today; each ESPN host; and whether an update left anything to re-pull. Tap a dataset for its detail."],
  [5, "Live", "Everything refreshes itself every 15 seconds while this page is open and in view, less often while the site saves its daily allowance. After 4 hours without a tap it pauses; tap the amber bar to carry on."],
  [6, "Times and sizes", "A time shows how long ago it was; tap it for the exact moment in your time zone, and tap again to go back. Hover a size for its exact bytes."],
  [7, "Looking changes nothing", "Nothing here changes the site or starts a refresh. To act on something you see here, use Site Configuration."],
  [8, "The Site API tab", "Everything about the API: who is asking how often, the pace, the rate window, the snapshot, and what it all costs. It only reads; the controls are in Site Configuration."],
  [9, "High activity", "Any address asking far more than the pace allows. Addresses are never shown, only an alias such as IPv4:3, and your own is marked You."],
  [10, "Likely member", "Locked until you give the Admin Password. It is a likelihood from page visits by the same address, not proof, and it locks again when you leave the page."],
  [11, "Jobs", "Which of the Site API page’s jobs are in use: requests by the name each example sends. A program with no name, or a name of its own, counts as Unknown, with its name shown if it sent one."],
];

const KINDS = [["", "everything"], ["visit", "visits"], ["sign-in", "sign-ins"], ["admin", "admin"], ["operation", "operations"], ["change", "changes of state"], ["status", "hourly status"]];
const RANGES = [{ value: "24h", label: "Last 24 hours" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }, { value: "season", label: "Whole season" }];

function readCookie(name) {
  try { const m = new RegExp("(?:^|; )" + name + "=([^;]*)").exec(document.cookie); return m ? decodeURIComponent(m[1]) : ""; } catch { return ""; }
}
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private window: kept for this visit only */ } },
};
const tabFromHash = () => { try { return decodeURIComponent((window.location.hash || "").replace(/^#/, "")) || "overview"; } catch { return "overview"; } };
const STATE_PHRASE = { bad: "Something this page depends on is failing", warn: "Something this page shows needs a look", run: "Working right now", ok: "Everything it depends on is healthy", idle: "Nothing to report" };

export default function SiteBackend() {
  const [theme, setTheme] = useState(() => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"));
  const [, setTzTick] = useState(0);
  const [tab, setTab] = useState(tabFromHash);
  const [data, setData] = useState({});
  const [open, setOpen] = useState({});
  const [status, setStatus] = useState("loading");
  const [problem, setProblem] = useState(null);
  const [act, setAct] = useState({ page: "", kind: "", sev: "", team: "all", q: "", range: "7d", season: null });
  const [feed, setFeed] = useState({ items: [], newestId: null, newestHour: null, oldestId: null, oldestAt: null, more: false, loaded: false });
  const [fresh, setFresh] = useState(() => new Set());
  const [pendingJump, setPendingJump] = useState(null);
  const [beatFresh, setBeatFresh] = useState(0);
  // High activity's likely members: fetched through the Admin Password popup, held in memory only, gone when the page is left.
  const [members, setMembers] = useState(null);
  const [asking, setAsking] = useState(false);
  const seenRef = useRef(null);
  const lastInteract = useRef(Date.now());
  const timer = useRef(null);
  const ctrl = useRef(null);
  const tabRef = useRef(tab);
  const openRef = useRef(open);
  const actRef = useRef(act);
  const feedRef = useRef(feed);
  const pausedRef = useRef(false);
  const lastBeatRef = useRef(null);
  tabRef.current = tab; openRef.current = open; actRef.current = act; feedRef.current = feed;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.cookie = `eft_theme=${theme}; path=/; max-age=31536000; samesite=lax`;
  }, [theme]);

  useEffect(() => {
    if (readCookie("eft_motion") === "reduce") document.documentElement.classList.add("stillness");
    const onTz = (e) => { setZone(e && e.detail && e.detail.zone ? e.detail.zone : readZone()); setTzTick((n) => n + 1); };
    window.addEventListener("tzchange", onTz);
    // "Since you last opened" compares against the previous visit from this browser.
    const prev = Number(store.get(SEEN_KEY)) || null;
    seenRef.current = prev;
    store.set(SEEN_KEY, String(Date.now()));
    return () => window.removeEventListener("tzchange", onTz);
  }, []);

  // ------------------------------------------------------------ fetching

  const query = useCallback((t, extra = {}) => {
    const q = new URLSearchParams();
    q.set("tab", t);
    // Every panel on the visible tab arrives with its body, so one opens at once with nothing left to read.
    if (t !== "activity") q.set("open", "*");
    if (seenRef.current) q.set("seen", String(seenRef.current));
    q.set("day0", String(localMidnight()));
    if (t === "activity") {
      const a = actRef.current;
      for (const k of ["page", "kind", "sev", "q", "range"]) if (a[k]) q.set(k, a[k]);
      if (a.team && a.team !== "all") q.set("team", a.team);
      if (a.season) q.set("season", String(a.season));
    }
    for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") q.set(k, String(v));
    return `${API}?${q.toString()}`;
  }, []);

  const load = useCallback(async (t, mode = "full") => {
    if (ctrl.current && mode !== "older") ctrl.current.abort();
    const c = new AbortController();
    if (mode !== "older") ctrl.current = c;
    const f = feedRef.current;
    const extra = t !== "activity" ? {} : mode === "poll" && f.loaded ? { after: f.newestId || 0, afterHour: f.newestHour || 0 }
      : mode === "older" ? { before: f.oldestId || "", beforeAt: f.oldestAt || "" } : {};
    try {
      const r = await fetch(query(t, extra), { credentials: "same-origin", signal: c.signal, cache: "no-store" });
      noteBrake(r);
      if (r.status === 401) { setProblem("signedout"); setStatus("error"); return; }
      if (r.status === 403) { const j = await r.json().catch(() => ({})); setProblem(j.locked ? "locked" : "hidden"); setStatus("error"); return; }
      const j = await r.json();
      if (j && j.paused) { setStatus("error"); setProblem("resting"); return; }
      if (!j || !j.ok) { setStatus("error"); setProblem(j && j.empty ? null : "server"); if (j && j.empty && t === "activity") setFeed({ items: [], newestId: null, newestHour: null, oldestId: null, oldestAt: null, more: false, loaded: true }); return; }
      setProblem(null);
      setStatus(pausedRef.current ? "paused" : "live");
      setData((d) => ({ ...d, [t]: j }));
      if (t === "overview" && j.strip && j.strip.lastTick && lastBeatRef.current !== j.strip.lastTick) {
        if (lastBeatRef.current != null) setBeatFresh((n) => n + 1);
        lastBeatRef.current = j.strip.lastTick;
      }
      if (t === "activity" && j.feed) {
        const fd = j.feed;
        if (mode === "poll" && f.loaded) {
          setFeed((old) => ((old.rest || null) === (fd.rest || null) ? old : { ...old, rest: fd.rest || null }));
          if (fd.items.length) {
            const ids = new Set(f.items.map((x) => x.id));
            const add = fd.items.filter((x) => !ids.has(x.id));
            if (add.length) {
              setFresh(new Set(add.map((x) => x.id)));
              setFeed((old) => ({ ...old, items: add.concat(old.items).sort((a, b) => toMs(b.at) - toMs(a.at)), newestId: fd.newestId || old.newestId, newestHour: fd.newestHour || old.newestHour }));
            } else setFeed((old) => ({ ...old, newestId: fd.newestId || old.newestId, newestHour: fd.newestHour || old.newestHour }));
          }
        } else if (mode === "older") {
          setFeed((old) => {
            const ids = new Set(old.items.map((x) => x.id));
            return { ...old, items: old.items.concat(fd.items.filter((x) => !ids.has(x.id))), oldestId: fd.oldestId || old.oldestId, oldestAt: fd.oldestAt || old.oldestAt, more: fd.more };
          });
        } else {
          setFresh(new Set());
          setFeed({ items: fd.items, newestId: fd.newestId, newestHour: fd.newestHour, oldestId: fd.oldestId, oldestAt: fd.oldestAt, more: fd.more, loaded: true, rest: fd.rest || null });
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      setStatus("error");
      setProblem("network");
    }
  }, [query]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInteract.current > IDLE_MS) { pausedRef.current = true; setStatus("paused"); return; }
      await load(tabRef.current, "poll");
      schedule();
    }, pollDelay(POLL_MS, { backstage: true }));   // slower while the site saves its daily allowance (C5)
  }, [load]);

  useEffect(() => {
    load(tab, "full").then(schedule);
    return () => clearTimeout(timer.current);
  }, [tab, load, schedule]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && !pausedRef.current) { load(tabRef.current, "poll").then(schedule); }
      else clearTimeout(timer.current);
    };
    const touch = () => { lastInteract.current = Date.now(); };
    const onHash = () => { const t = tabFromHash(); if (t !== tabRef.current) setTab(t); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("keydown", touch);
    window.addEventListener("wheel", touch, { passive: true });
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
      window.removeEventListener("wheel", touch);
      window.removeEventListener("hashchange", onHash);
    };
  }, [load, schedule]);

  const resume = () => { pausedRef.current = false; lastInteract.current = Date.now(); setStatus("live"); load(tabRef.current, "poll").then(schedule); };

  // ------------------------------------------------------------ navigation

  const go = useCallback((t, page) => {
    if (t === "activity" && page) setAct((a) => ({ ...a, page }));
    if (t !== tabRef.current) {
      try { window.history.replaceState(null, "", `#${encodeURIComponent(t)}`); } catch { window.location.hash = t; }
      setTab(t);
    } else if (t === "activity") setTimeout(() => load("activity", "full"), 0);
    window.scrollTo({ top: 0 });
  }, [load]);

  const setPanelOpen = useCallback((id, on) => {
    setOpen((o) => {
      const cur = new Set(o[tabRef.current] || []);
      if (on) cur.add(id); else cur.delete(id);
      const next = { ...o, [tabRef.current]: cur };
      openRef.current = next;
      return next;
    });
  }, []);

  const jump = useCallback((id) => {
    if (!(openRef.current[tabRef.current] || new Set()).has(id)) setPanelOpen(id, true);
    setPendingJump(id);
  }, [setPanelOpen]);

  useEffect(() => {
    if (!pendingJump) return;
    const el = document.getElementById(pendingJump);
    if (el) { el.scrollIntoView({ behavior: document.documentElement.classList.contains("stillness") ? "auto" : "smooth", block: "start" }); setPendingJump(null); }
  });

  const allPanels = (on) => {
    const d = data[tab];
    const ids = ((d && d.panels) || []).map((p) => p.id);
    setOpen((o) => { const next = { ...o, [tab]: new Set(on ? ids : []) }; openRef.current = next; return next; });
  };

  const markSeen = useCallback(() => {
    seenRef.current = Date.now();
    store.set(SEEN_KEY, String(seenRef.current));
    load(tabRef.current, "poll");
  }, [load]);

  // A dataset's detail costs a call to its coordinator, so it is read when a row is about
  // to open (a pointer resting on it, or focus) rather than for every row on every poll,
  // and kept for a minute or until the dataset refreshes.
  const detailCache = useRef(new Map());
  const detail = useCallback((key, newest) => {
    const c = detailCache.current.get(key);
    if (c && c.newest === newest && Date.now() - c.at < 60000) return c.p;
    const p = fetch(`${API}?dataset=${encodeURIComponent(key)}`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => r.json()).then((j) => { if (!j || !j.ok) throw new Error("no detail"); return j; });
    const entry = { at: Date.now(), newest, p, v: null };
    detailCache.current.set(key, entry);
    p.then((v) => { entry.v = v; }, () => { if (detailCache.current.get(key) === entry) detailCache.current.delete(key); });
    return p;
  }, []);
  const cachedDetail = useCallback((key, newest) => {
    const c = detailCache.current.get(key);
    return c && c.newest === newest && c.v && Date.now() - c.at < 60000 ? c.v : null;
  }, []);

  // Activity filters reload the feed from the top.
  const firstAct = useRef(true);
  useEffect(() => {
    if (firstAct.current) { firstAct.current = false; return; }
    if (tabRef.current !== "activity") return;
    const h = setTimeout(() => load("activity", "full"), act.q ? 400 : 0);
    return () => clearTimeout(h);
  }, [act, load]);

  // ------------------------------------------------------------ render

  const d = data[tab] || null;
  const any = Object.values(data)[0] || null;
  const tabs = (d && d.tabs) || (any && any.tabs) || [{ key: "overview", name: "Overview" }, { key: "activity", name: "Activity" }];
  const league = (d && d.league) || (any && any.league) || "";
  // The active tab is scrolled into view in the strip, once the strip has its tabs (a page opened
  // straight onto a later tab draws the full strip only when the first answer arrives).
  const tabCount = tabs.length;
  useEffect(() => {
    const el = document.querySelector(`.tab[data-k="${CSS.escape(tab)}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, tabCount]);
  const askMembers = useCallback(() => setAsking(true), []);
  const ctx = useMemo(() => ({ teams: (d || any || {}).teams || {}, pages: (d || any || {}).pages || [], go, jump, markSeen, detail, cachedDetail, members, askMembers }),
    [d, any, go, jump, markSeen, detail, cachedDetail, members, askMembers]);
  const openSet = open[tab] || new Set();

  return (
    <Ctx.Provider value={ctx}>
      <div className="wrap">
        <header className="top">
          <a className="back" href="/">← Back to home</a>
          <div className="ctl">
            <ToolControls steps={HELP} label="How Site Backend works" theme={theme} onTheme={setTheme} />
          </div>
        </header>
        <div className="titlerow">
          <h1>Site Backend<span className="cur" aria-hidden="true" /></h1>
          <LiveState status={status} at={d && d.at} />
          {league ? <span className="toolleague">{league}</span> : null}
        </div>
        <div className="tabbar">
          <ScrollBox>
            <nav className="tabs" role="tablist" aria-label="Site Backend sections">
              {tabs.map((t) => (
                <button key={t.key} data-k={t.key} className="tab" role="tab" type="button" aria-selected={t.key === tab} onClick={() => go(t.key)}>
                  {t.s ? <Dot s={t.s} /> : null}{t.name}
                </button>
              ))}
            </nav>
          </ScrollBox>
        </div>
        {status === "paused" ? <button className="idlebar" type="button" onClick={resume}><b>Paused</b> after 4 hours without a tap. Tap to resume live updates.</button> : null}
        {problem ? <Problem kind={problem} /> : null}
        {d && d.rest ? <div className="restbar" role="status"><b>Saving reads</b> {d.rest.text}</div> : null}
        <main>
          {!d ? <div className="empty" style={{ marginTop: 14 }}>{problem ? "Nothing to show until the site can be reached." : "Reading the site…"}</div>
            : tab === "activity" ? <Activity d={d} act={act} setAct={setAct} feed={feed} fresh={fresh} older={() => load("activity", "older")} />
              : <TabBody d={d} tab={tab} openSet={openSet} setPanelOpen={setPanelOpen} jump={jump} allPanels={allPanels} beatFresh={beatFresh} />}
        </main>
        <div className="toolfoot">
          <a className="gh" href="https://github.com/shortcutsbin-netizen" target="_blank" rel="noopener noreferrer">GitHub - shortcutsbin-netizen</a>
        </div>
      </div>
      {asking ? <MembersPopup aliases={lockedAliases(data)} onClose={() => setAsking(false)} onShown={(m) => { setMembers((old) => ({ ...(old || {}), ...m })); setAsking(false); }} /> : null}
    </Ctx.Provider>
  );
}

/** Every locked likely member on the page's tabs: the aliases the popup asks about. */
function lockedAliases(data) {
  const out = new Set();
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.member === "locked" && typeof x.alias === "string") out.add(x.alias);
    if (typeof x.lock === "string") out.add(x.lock);
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
  };
  walk(data);
  return [...out];
}

const EYE = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;

/**
 * The Admin Password popup that shows likely members. The password is typed, never pasted, sent only in the
 * x-admin-password header to an admin route that changes nothing, and never kept: the members it returns live in
 * this page's memory until the page is left.
 */
function MembersPopup({ aliases, onClose, onShown }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const opener = useRef(typeof document !== "undefined" ? document.activeElement : null);
  useEffect(() => {
    if (input.current) input.current.focus({ preventScroll: true });
    const key = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { onClose(); if (opener.current && opener.current.focus) opener.current.focus({ preventScroll: true }); };
  const submit = async () => {
    if (!pw) { setErr("Type the Admin Password first."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/admin/site-api-members", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "x-admin-password": pw }, body: JSON.stringify({ aliases }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setBusy(false); setErr(r.status === 429 ? "Too many attempts. Try again in a few minutes." : "That password isn’t right."); if (input.current) input.current.select(); return; }
      setPw("");
      onShown(Object.fromEntries(aliases.map((a) => [a, (j.members || {})[a] || { teams: [] }])));
    } catch { setBusy(false); setErr("The site could not be reached. Try again."); }
  };
  return (
    <div className="pwscrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="pwbox" role="dialog" aria-modal="true" aria-label="Show likely members">
        <h2>Show likely members</h2>
        <p>Which team is likely behind each address stays locked until whoever administers this site gives the Admin Password. It shows for this visit only: leaving the page locks it again.</p>
        <label htmlFor="sbpw">Admin Password</label>
        <div className="pwr">
          <input id="sbpw" ref={input} type={show ? "text" : "password"} autoComplete="current-password" spellCheck={false} value={pw}
            onChange={(e) => setPw(e.target.value)} onPaste={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          <button type="button" className="eye" aria-label="Show or hide password" onClick={() => setShow((v) => !v)}>{EYE}</button>
        </div>
        {err ? <div className="err" role="alert">{err}</div> : null}
        <div className="bt"><button type="button" className="btn" onClick={close}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={submit}>{busy ? "Checking" : "Show"}</button></div>
      </div>
    </div>
  );
}

function LiveState({ status, at }) {
  const now = useNow();
  const ms = toMs(at);
  const ago = ms ? Math.max(0, Math.round((now - ms) / 1000)) : null;
  const text = status === "paused" ? "paused" : status === "error" ? "not updating" : status === "loading" ? "connecting" : `live${ago != null ? ` · updated ${ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`} ago` : ""}`;
  return <span className={"livestate" + (status === "paused" ? " paused" : status === "error" ? " err" : "")}><span className="livedot" />{text}</span>;
}

function Problem({ kind }) {
  const text = {
    locked: "Your unlock has lapsed: each lasts 30 minutes. Reload the page and enter the Admin Password again to carry on.",
    hidden: "Site Backend has been switched off in Site Configuration.",
    signedout: "Your session has ended. Reload the page to sign in again.",
    network: "The site could not be reached. This page keeps trying every 15 seconds.",
    server: "The site answered with an error. This page keeps trying every 15 seconds.",
    resting: "The site is saving what is left of a free daily limit for the work that must never stop (live scoring, the timeline, data refreshes), so Site Backend rests until the day's use falls back or the limits reset at 00:00 UTC. This page asks again every 5 minutes.",
  }[kind] || "Something went wrong.";
  return <div className="errbar">{text}{["locked", "signedout", "hidden"].includes(kind) ? <> <button className="linkbtn" type="button" onClick={() => window.location.reload()}>Reload</button></> : null}</div>;
}

function Hero({ d, beatFresh }) {
  if (d.tab === "overview") {
    const v = d.verdict || { s: "ok", word: "All good", n: 0 };
    const beat = (d.strip && d.strip.beat) || [];
    const ticks = beat.filter((b) => b === 1).length, counted = beat.filter((b) => b != null).length;
    return (
      <section className="hero">
        <div className="verdict"><span className={`vword s-${v.s}`} style={{ "--c": `var(${v.s === "bad" ? "--red" : v.s === "warn" ? "--amber" : "--acc"})` }}>{v.word}</span>
          <span className="vwhy">{v.n ? `${v.n} ${v.n === 1 ? "thing needs" : "things need"} a look, listed below` : "Every check passed at the last refresh"}</span></div>
        <div className="beat"><Heartbeat beat={beat} fresh={beatFresh} /></div>
        <div className="beatcap"><span>Cron heartbeat, last 60 minutes</span><span>{counted ? `${ticks} of ${counted} ticks` : "no ticks recorded yet"}</span><span>{d.strip && d.strip.lastTick ? <>last tick <Time v={d.strip.lastTick} /></> : "no tick yet"}</span></div>
        <KV items={(d.strip && d.strip.kv) || []} />
      </section>
    );
  }
  if (d.page) {
    const s = (d.tabs.find((t) => t.key === d.tab) || {}).s || "ok";
    return (
      <section className="hero">
        <div className="verdict"><span className="vword" style={{ "--c": `var(${s === "bad" ? "--red" : s === "warn" ? "--amber" : s === "run" ? "--blue" : "--acc"})` }}>{d.page.name}</span>
          <span className="vwhy">{STATE_PHRASE[s] || ""}</span></div>
        <KV items={(d.strip && d.strip.kv) || []} />
      </section>
    );
  }
  return <section className="hero"><KV items={(d.strip && d.strip.kv) || []} /></section>;
}

function TabBody({ d, tab, openSet, setPanelOpen, jump, allPanels, beatFresh }) {
  const panels = d.panels || [];
  return (
    <>
      <Hero d={d} beatFresh={beatFresh} />
      {panels.length ? (
        <nav className="jump" aria-label="Panels on this tab">
          {panels.map((p) => (
            <button key={p.id} className={"jchip" + (openSet.has(p.id) ? " open" : "")} type="button" title={p.sum ? p.sum[1] : p.title} onClick={() => jump(p.id)}>
              {p.sum && p.sum[0] ? <Dot s={p.sum[0]} /> : <span className="nd" aria-hidden="true" />}{p.title}
            </button>
          ))}
          <span className="jall"><button type="button" onClick={() => allPanels(true)}>Open all</button><button type="button" onClick={() => allPanels(false)}>Close all</button></span>
        </nav>
      ) : null}
      {panels.map((p) => <Panel key={`${tab}:${p.id}`} p={p} at={d.at} open={openSet.has(p.id)} onToggle={() => setPanelOpen(p.id, !openSet.has(p.id))} />)}
    </>
  );
}

function Panel({ p, at, open, onToggle }) {
  return (
    <section className={"panel" + (open ? "" : " shut")} id={p.id}>
      <div className="ph">
        <button className="tog" type="button" aria-expanded={open} aria-controls={`b-${p.id}`} onClick={onToggle}>
          <span className="caret" aria-hidden="true">▾</span>
          <span className="phx">
            <span className="pt">{p.title}</span>
            <span className="psum">{p.sum && p.sum[0] ? <Dot s={p.sum[0]} /> : null}<span>{p.sum ? p.sum[1] : ""}</span></span>
            {p.sub ? <span className="ps">{p.sub}</span> : null}
          </span>
        </button>
        {p.live ? <span className="asof">as of {clockText(toMs(at))}</span> : p.asof ? <span className="asof">{p.asof}</span> : null}
      </div>
      {open ? <div className="pb" id={`b-${p.id}`}>{p.body ? <Blocks list={p.body} /> : <div className="empty">{p.error ? "This panel could not be read at the last refresh. It is tried again every 15 seconds." : "Nothing to show."}</div>}</div> : null}
    </section>
  );
}

function Activity({ d, act, setAct, feed, fresh, older }) {
  const teams = Object.entries(d.teams || {}).map(([id, t]) => ({ value: String(id), label: t.name }));
  const teamOpts = [{ value: "all", label: "All teams" }, ...teams, { value: "none", label: "No team chosen" }];
  const pageOpts = [{ value: "", label: "All pages" }, ...(d.pages || []).map(([k, n]) => ({ value: k, label: n }))];
  const seasonOpts = (d.seasons || []).map((y) => ({ value: String(y), label: String(y) }));
  const [q, setQ] = useState(act.q);
  useEffect(() => { const h = setTimeout(() => { if (q !== act.q) setAct((a) => ({ ...a, q })); }, 350); return () => clearTimeout(h); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const chip = (field, v, label) => <button key={field + v} className="chip" type="button" aria-pressed={act[field] === v} onClick={() => setAct((a) => ({ ...a, [field]: v }))}>{label}</button>;
  return (
    <>
      <Hero d={d} />
      <section className="panel" id="p-feed">
        <div className="ph">
          <span className="tog" style={{ cursor: "default" }}>
            <span className="phx"><span className="pt">Site log</span>
              <span className="ps">Season {d.season}, kept for good. Visits and sign-ins name the team chosen on that browser; nothing else about a visitor is recorded.</span></span>
          </span>
          <span className="asof">as of {clockText(toMs(d.at))}</span>
        </div>
        <div className="pb">
          <div className="pickers">
            {seasonOpts.length > 1 ? <TeamSelect label="Season" value={String(act.season || d.season)} options={seasonOpts} onChange={(v) => setAct((a) => ({ ...a, season: Number(v) }))} /> : null}
            <TeamSelect label="Page" value={act.page} options={pageOpts} placeholder="All pages" onChange={(v) => setAct((a) => ({ ...a, page: v }))} />
            <TeamSelect label="Team" value={act.team} options={teamOpts} placeholder="All teams" onChange={(v) => setAct((a) => ({ ...a, team: v }))} />
            <TeamSelect label="Range" value={act.range} options={RANGES} onChange={(v) => setAct((a) => ({ ...a, range: v }))} />
          </div>
          <div className="filters"><input type="search" placeholder="Search the log" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the log" /></div>
          <div className="chips">{KINDS.map(([k, l]) => chip("kind", k, l))}{chip("sev", "", "any severity")}{chip("sev", "problems", "warnings and failures")}</div>
          {!feed.loaded ? <div className="loading">Reading the log…</div> : <>
            {feed.rest ? <div className="restnote">{feed.rest}</div> : null}
            <p className="note" style={{ margin: "0 0 8px" }}>{num(feed.items.length)} {feed.items.length === 1 ? "entry" : "entries"} shown{feed.more ? ", more below" : ""}.</p>
            <Feed items={feed.items} fresh={fresh} />
            {feed.more ? <button className="more" type="button" onClick={older}>Show older entries</button> : null}
          </>}
        </div>
      </section>
    </>
  );
}
