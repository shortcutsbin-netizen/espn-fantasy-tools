import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import SettingsMenu from "./SettingsMenu.jsx";
import Instructions from "./Instructions.jsx";

/**
 * The help and settings buttons every tool carries, holding their own open state.
 * Opening either re-renders these controls only, never the tool around them: a tool
 * whose content is costly to render (a record book, a set of live charts) otherwise
 * rebuilt all of it just to show a menu. The help dialog is portalled to the page
 * body, so it overlays the page exactly as before wherever the controls sit.
 */
export default function ToolControls({ steps, label, theme, onTheme, gearId }) {
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const gearRef = useRef(null);
  return (
    <React.Fragment>
      <button className="ctlbtn" onClick={() => setShowHelp(true)} title="How to use this tool" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9.4" /><path d="M9.2 9.3a2.8 2.8 0 1 1 3.9 2.9c-.9.5-1.4 1-1.4 2.1" /><circle cx="12" cy="17.2" r=".55" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <button className="ctlbtn" id={gearId} ref={gearRef} title="Site settings" aria-haspopup="dialog" type="button"
        onClick={(e) => { e.stopPropagation(); setShowSettings((v) => !v); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.1" /><path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a2 2 0 1 1-4 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9H3a2 2 0 1 1 0-4h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.5 1.5 0 0 0 1.7.3H9a1.5 1.5 0 0 0 .9-1.4V3a2 2 0 1 1 4 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.5 1.5 0 0 0-.3 1.7V9a1.5 1.5 0 0 0 1.4.9h.2a2 2 0 1 1 0 4h-.1a1.5 1.5 0 0 0-1.4.9z" /></svg>
      </button>
      <SettingsMenu open={showSettings} onClose={() => setShowSettings(false)} theme={theme} onTheme={onTheme} anchorRef={gearRef} />
      {showHelp && typeof document !== "undefined" ? createPortal(<Instructions open steps={steps} onClose={() => setShowHelp(false)} label={label} />, document.body) : null}
    </React.Fragment>
  );
}
