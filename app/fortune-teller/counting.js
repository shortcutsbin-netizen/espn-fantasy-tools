/**
 * Everything the page counts, in one place, run either in a Web Worker (so a map of
 * any size never freezes the page) or in the page itself when no worker is available.
 *
 * A request carries the results set now and the results already played. The played
 * results change only when the team, the week or What-if changes, so what depends on
 * them alone (the finish spread, win out, lose out, odds by week) is cached; an
 * ordinary click costs one pass.
 */
import { countLean, totalsOf, simplestPath } from "./engine.js";

export function computeState(map, req, cache) {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()), t0 = now();
  const { pins, settled, places, n, extras } = req; let baseMs = 0;
  const baseKey = req.team + ":" + Array.from(settled).join("");
  if (cache.baseKey !== baseKey) {
    // Totals need only the paths reaching each leaf: one number a node, whatever the spread.
    const b = totalsOf(map, settled, places, n);
    const share = (p) => { const r = totalsOf(map, p, places, 0); return r[1] / r[0]; };
    cache.baseKey = baseKey;
    cache.base = { total: Array.from(b) };
    cache.winOut = extras.winOut ? share(extras.winOut) : null;
    cache.loseOut = extras.loseOut ? share(extras.loseOut) : null;
    cache.series = extras.series.map((s) => ({ week: s.week, kind: s.kind, v: share(s.pins) }));
    baseMs = now() - t0;
  }
  const t1 = now(), c = countLean(map, pins, places), curMs = now() - t1;
  return { key: req.key, timing: { baseMs: Math.round(baseMs), curMs: Math.round(curMs) }, base: cache.base, winOut: cache.winOut, loseOut: cache.loseOut, series: cache.series,
    cur: { total: Array.from(c.total), M: Array.from(c.M) } };
}

export function computeSimplest(map, req) {
  return { key: req.key, res: simplestPath(map, req.pins, req.places, { order: req.order, prefer: (j) => req.prefer[j], budgetMs: req.budgetMs, maxWork: req.maxWork || 30e6 }) };
}

/**
 * The page's side. Uses ./worker.js when it can be started, and the page itself
 * otherwise (a preview without a session, or a browser without workers). Both
 * answer the same questions with the same code.
 */
/** A map's compressed bytes into nodes, wherever this runs (a worker or the page). */
export async function inflateMap(m) {
  if (m.nodes) return m;
  const stream = new Blob([m.bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return { nodes: new Int32Array(await new Response(stream).arrayBuffer()), root: m.root, G: m.G, leafBase: m.leafBase, leaves: m.leaves };
}

/**
 * The page's side. Counting runs in ./worker.js and the simplest-path search in a second
 * copy of it, so a long search never holds up a count. Maps arrive compressed and are
 * inflated inside each worker, so the page never holds a large map at all. Without
 * workers (a preview with no session, or an old browser) the same code runs in the page.
 */
export function makeCounter() {
  const start = () => {
    try {
      if (typeof Worker !== "function" || typeof location === "undefined" || !location.protocol.startsWith("http") || window.__FT_PREVIEW__) return null;
      const w = new Worker(new URL("./worker.js", location.href)), waiting = new Map();
      w.onmessage = (e) => { const x = waiting.get(e.data.id); if (x) { waiting.delete(e.data.id); e.data.error ? x.reject(new Error(e.data.error)) : x.resolve(e.data.out); } };
      w.onerror = () => { const all = [...waiting.values()]; waiting.clear(); all.forEach((x) => x.reject(new Error("worker failed"))); };
      return { w, waiting };
    } catch (e) { return null; }
  };
  const counts = start(); let search = counts ? start() : null;
  let seq = 0, map = null; const cache = {};
  const post = (wk, type, payload, transfer) => new Promise((resolve, reject) => { const id = ++seq; wk.waiting.set(id, { resolve, reject }); wk.w.postMessage({ id, type, payload }, transfer || []); });
  return {
    get inWorker() { return !!counts; },
    async load(m) {
      if (!counts) { map = await inflateMap(m); for (const k of Object.keys(cache)) delete cache[k]; return true; }
      const meta = { root: m.root, G: m.G, leafBase: m.leafBase, leaves: m.leaves };
      // A new team cancels any search still running for the last one: the search worker is
      // replaced, not waited on, and gets its own copy of the map. Only counting is awaited.
      const copy = m.bytes.slice();
      if (search) { search.w.terminate(); [...search.waiting.values()].forEach((x) => x.reject(new Error("replaced"))); }
      search = start();
      if (search) post(search, "load", { ...meta, bytes: copy }, [copy.buffer]).catch(() => {});
      await post(counts, "load", { ...meta, bytes: m.bytes }, [m.bytes.buffer]);
      return true;
    },
    state: (req) => (counts ? post(counts, "state", req) : Promise.resolve().then(() => computeState(map, req, cache))),
    simplest: (req) => (search ? post(search, "simplest", req) : counts ? Promise.reject(new Error("no search worker")) : Promise.resolve().then(() => computeSimplest(map, req))),
  };
}
