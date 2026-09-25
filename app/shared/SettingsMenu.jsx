import React, { useState, useEffect, useRef } from "react";
import { MOTION_COOKIE, THEME_COOKIE, TZ_COOKIE } from "../../src/ui.js";

/**
 * The settings panel, for client-rendered tools.
 *
 * Server-rendered surfaces get this from `shell()`. A tool builds its own
 * chrome, so without a shared component each one would grow its own version and
 * the site would end up with several places to change the same three things.
 * The markup deliberately reuses the class names in BASE_CSS, so this is the
 * same panel rather than one that resembles it.
 *
 * The time-zone control is the shell's own listbox rather than a native select:
 * same markup, same classes, same filter, same "use my device zone" escape. A
 * setting that behaves one way on the dashboard and another inside a tool is a
 * setting the reader has to learn twice.
 */

const FALLBACK_ZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver",
  "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
  "America/Halifax", "America/Sao_Paulo", "Europe/London", "Europe/Dublin",
  "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Athens",
  "Europe/Moscow", "Africa/Lagos", "Africa/Johannesburg", "Africa/Cairo",
  "Asia/Jerusalem", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka",
  "Asia/Bangkok", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore",
  "Australia/Perth", "Australia/Sydney", "Pacific/Auckland",
];

function zoneList() {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      const v = Intl.supportedValuesOf("timeZone");
      if (v && v.length) return v;
    }
  } catch { /* older engines do not enumerate zones */ }
  return FALLBACK_ZONES;
}

function deviceZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const m = new RegExp("(?:^|; )" + name + "=([^;]*)").exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : "";
}

function setCookie(k, v) {
  document.cookie = `${k}=${v}; path=/; max-age=31536000; samesite=lax`;
}

/** "America/New_York" reads better as "America / New York". */
function tzLabel(zone) {
  return String(zone).split("_").join(" ").split("/").join(" / ");
}

/**
 * Current offset, so a zone name is not the only thing to go on. Building a
 * formatter per zone is expensive (the list has hundreds), so offsets are kept
 * for an hour: they only move with daylight saving.
 */
const OFFSETS = new Map();
function offsetLabel(zone) {
  const now = Date.now(), hit = OFFSETS.get(zone);
  if (hit && now - hit.at < 3600000) return hit.label;
  let label = "";
  try {
    const s = new Intl.DateTimeFormat("en-US",
      { timeZone: zone, timeZoneName: "shortOffset" }).format(new Date(now));
    const m = s.match(/GMT[+-]?\d*(?::\d+)?/);
    label = m ? m[0] : "";
  } catch { label = ""; }
  OFFSETS.set(zone, { label, at: now });
  return label;
}

export default function SettingsMenu({ open, onClose, theme, onTheme, anchorRef }) {
  const [motion, setMotion] = useState(
    () => readCookie(MOTION_COOKIE) === "reduce");
  const [tz, setTz] = useState(() => readCookie(TZ_COOKIE));
  const [listOpen, setListOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const boxRef = useRef(null);
  const zones = useRef(null);
  if (!zones.current) {
    const all = zoneList().slice();
    const device = deviceZone();
    // The device zone is always offered, even on an engine that will not
    // enumerate zones and falls back to the short list.
    if (device && all.indexOf(device) === -1) all.unshift(device);
    zones.current = all;
  }

  useEffect(() => {
    document.documentElement.classList.toggle("stillness", motion);
    setCookie(MOTION_COOKIE, motion ? "reduce" : "full");
  }, [motion]);

  // Closing on an outside click is what makes this feel like the shell's menu
  // rather than a dialog that has to be dismissed deliberately.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (boxRef.current && boxRef.current.contains(e.target)) return;
      if (anchorRef && anchorRef.current && anchorRef.current.contains(e.target)) return;
      setListOpen(false);
      onClose();
    };
    const esc = (e) => {
      if (e.key !== "Escape") return;
      // Escape closes the zone list first, then the panel, so one keypress
      // does not dismiss both at once.
      if (listOpen) setListOpen(false); else onClose();
    };
    document.addEventListener("click", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("click", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, onClose, anchorRef, listOpen]);

  const applyTz = (value) => {
    setTz(value);
    setCookie(TZ_COOKIE, value);
    // Anything rendering a time listens for this rather than reading the cookie
    // once on load, so the whole page re-renders in the new zone immediately.
    // Same event and payload shape the shell dispatches, so anything already
    // listening works inside a tool without knowing which surface it is on.
    window.dispatchEvent(new CustomEvent("tzchange",
      { detail: { zone: value || deviceZone() } }));
  };

  const effective = tz || deviceZone();
  const label = tzLabel;
  const q = filter.trim().toLowerCase();
  const shown = q ? zones.current.filter((z) => z.toLowerCase().includes(q)) : zones.current;

  return (
    <div className={`settings${open ? " open" : ""}`} ref={boxRef}
         role="dialog" aria-label="Site settings">
      <div className="setttl">Site settings</div>

      <div className="setrow">
        <span className="setlab">Reduce motion<small>Stills the background</small></span>
        <button className="sw" role="switch" aria-checked={String(motion)}
                aria-label="Reduce motion" type="button"
                onClick={() => setMotion((m) => !m)} />
      </div>

      <div className="setrow">
        <span className="setlab">Light theme<small>Evil. Dark mode is superior</small></span>
        <button className="sw" role="switch" aria-checked={String(theme === "light")}
                aria-label="Light theme" type="button"
                onClick={() => onTheme(theme === "light" ? "dark" : "light")} />
      </div>

      <div className="setrow tzrow">
        <span className="setlab">Time zone
          <small>{tz ? label(effective) : `Detected - ${label(effective)}`}</small>
        </span>
      </div>
      <div className={`tzpick${listOpen ? " openpick" : ""}`}>
        <div className={`xsel${listOpen ? " open" : ""}`} data-value={effective}>
          <button type="button" className="xselbtn" aria-haspopup="listbox"
                  aria-expanded={String(listOpen)}
                  onClick={(e) => { e.stopPropagation(); setListOpen((v) => !v); }}>
            <span className="xselval">{label(effective)}</span>
            <span className="xselchev" aria-hidden="true" />
          </button>
          <ul className="xsellist" role="listbox">
            {/* Inside the listbox, so its clicks must not read as a selection
                or as a click-away that closes the menu. */}
            <li className="tzfilterrow" aria-hidden="true" onClick={(e) => e.stopPropagation()}>
              <input className="tzfilter" type="text" placeholder="Search zones"
                     autoComplete="off" spellCheck="false" aria-label="Search time zones"
                     value={filter} onChange={(e) => setFilter(e.target.value)} />
            </li>
            {/* The zones are only rendered while the list is open: hundreds of rows
                that nobody can see should not be rebuilt on every render. */}
            {listOpen ? shown.map((z) => {
              const off = offsetLabel(z);
              return (
                <li key={z} role="option" aria-selected={z === effective}
                    className={z === effective ? "on" : undefined}
                    onClick={(e) => { e.stopPropagation(); applyTz(z); setListOpen(false); }}>
                  {label(z)}
                  {off ? <small>{off}</small> : null}
                </li>
              );
            }) : null}
          </ul>
        </div>
        <button type="button" className="tzauto"
                onClick={() => { applyTz(""); setListOpen(false); }}>Use my device zone</button>
      </div>
    </div>
  );
}
