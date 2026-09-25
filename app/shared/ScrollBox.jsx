import React, { useCallback, useEffect, useRef } from "react";

/**
 * The site's drawn horizontal scroller for anything wider than its column (a table with
 * long team names on a phone): the page never scrolls sideways, and the bar is always
 * visible rather than the platform's overlay, which on touch appears only once a finger
 * is already moving. Moved here unchanged from Hall of Fame so every tool shares it.
 */
export default function ScrollBox({ children }) {
  const realRef = useRef(null);
  const barRef = useRef(null);
  const thumbRef = useRef(null);
  const drag = useRef(null);

  const layout = useCallback(() => {
    const real = realRef.current, bar = barRef.current, thumb = thumbRef.current;
    if (!real || !bar || !thumb) return;
    const cw = real.clientWidth, sw = real.scrollWidth;
    if (sw <= cw + 1) { bar.hidden = true; return; }
    bar.hidden = false;
    const barW = bar.clientWidth || cw;
    const tw = Math.max(32, Math.round(barW * (cw / sw)));
    thumb.style.width = `${tw}px`;
    const max = sw - cw;
    thumb.style.transform = `translateX(${max > 0 ? (real.scrollLeft / max) * (barW - tw) : 0}px)`;
  }, []);

  useEffect(() => {
    layout();
    const real = realRef.current;
    if (!real) return undefined;
    // Deferred a frame for the same reason as the identity strips: layout()
    // writes to the very element being observed, so calling it synchronously
    // from the observer re-entered it.
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; layout(); }); };
    let ro = null;
    if (typeof ResizeObserver === "function") {
      try { ro = new ResizeObserver(schedule); ro.observe(real); } catch { ro = null; }
    }
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (ro) ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [layout, children]);

  const onDown = (e) => {
    const real = realRef.current, thumb = thumbRef.current, bar = barRef.current;
    if (!real || !thumb) return;
    drag.current = { x: e.clientX, left: real.scrollLeft, tw: thumb.offsetWidth, barW: bar.clientWidth };
    bar.classList.add("dragging");
    try { thumb.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    e.preventDefault();
    e.stopPropagation();
  };
  const onMove = (e) => {
    const d = drag.current, real = realRef.current;
    if (!d || !real) return;
    const travel = Math.max(1, d.barW - d.tw);
    real.scrollLeft = d.left + ((e.clientX - d.x) / travel) * (real.scrollWidth - real.clientWidth);
    layout();
    e.preventDefault();
  };
  const onUp = (e) => {
    if (!drag.current) return;
    drag.current = null;
    if (barRef.current) barRef.current.classList.remove("dragging");
    try { thumbRef.current.releasePointerCapture(e.pointerId); } catch { /* not fatal */ }
  };
  const onTrack = (e) => {
    if (e.target === thumbRef.current) return;
    const real = realRef.current;
    if (!real) return;
    const r = barRef.current.getBoundingClientRect();
    const frac = (e.clientX - r.left) / Math.max(1, r.width);
    real.scrollLeft = frac * (real.scrollWidth - real.clientWidth);
    layout();
  };

  return (
    <div className="scrollwrap">
      <div className="sbar" ref={barRef} hidden onPointerDown={onTrack}>
        <div className="sbar-thumb" ref={thumbRef}
          onPointerDown={onDown} onPointerMove={onMove}
          onPointerUp={onUp} onPointerCancel={onUp} />
      </div>
      <div className="scrollreal" ref={realRef} onScroll={layout}>{children}</div>
    </div>
  );
}
