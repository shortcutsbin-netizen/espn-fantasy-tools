import React, { useEffect, useRef } from "react";
import { attachVScroll } from "../../src/vscroll.js";

/**
 * "How this works", for the React tools.
 *
 * The same dialog the server-rendered pages get from instructionsDialog() in
 * src/ui.js, and it behaves the way the update notice does: a panel over the
 * page rather than a sheet that replaces it, dismissed by the button, by
 * Escape, or by clicking the page behind it. One definition, so a tool cannot
 * end up with a help panel that opens differently from every other surface.
 *
 * steps: [[number, title, body], ...]
 */
export default function Instructions({ open, steps, onClose, label = "How this page works" }) {
  const paneRef = useRef(null);
  const barRef = useRef(null);
  const doneRef = useRef(null);
  const openerRef = useRef(null);

  // The drawn bar, the same one the server-rendered pages get.
  useEffect(() => {
    if (!open || !paneRef.current || !barRef.current) return undefined;
    return attachVScroll(paneRef.current, barRef.current);
  }, [open, steps]);

  /* Focus follows the dialog and is handed back when it closes, or a keyboard
     reader is left behind the page it just opened. */
  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;
    // The button sits at the foot of the scrolling pane: focusing it plainly scrolled the dialog to
    // its end, so a reader opened the help on its last step. Focus it without scrolling; start at the top.
    if (doneRef.current) doneRef.current.focus({ preventScroll: true });
    const pane = doneRef.current && doneRef.current.closest('.instr') ? doneRef.current.closest('.instr').querySelector('.vscroll, [data-vscroll]') : null;
    if (pane) pane.scrollTop = 0;
    return () => {
      if (openerRef.current && openerRef.current.focus) openerRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="instr" role="dialog" aria-modal="true" aria-label={label}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="instrwrap vwrap">
        <div className="instrbody vscroll" ref={paneRef}>
          <div className="instrhead">
            <h2>How this works</h2>
          </div>
          {(steps || []).map(([n, title, body]) => (
            <div className="istep" key={String(n)}>
              <span className="inum">{n}</span>
              <span><b>{title}</b><p>{body}</p></span>
            </div>
          ))}
          <button className="primary" type="button" ref={doneRef} onClick={onClose}>Got it</button>
        </div>
        <div className="vbar" hidden ref={barRef}><div className="vbar-thumb" /></div>
      </div>
    </div>
  );
}
