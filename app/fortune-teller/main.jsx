import React from "react";
import { createRoot } from "react-dom/client";
import FortuneTeller from "./FortuneTeller.jsx";

/* The preview inlines everything, because it has no session to fetch with;
   the page fetches the summary, then each team's map when it is first shown. */
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Int32Array(await new Response(stream).arrayBuffer());
}
function b64bytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }

async function fetchMap(data, teamIdx, onProgress) {
  const t = data.teams[teamIdx], meta = data.maps.find((m) => m.teamId === t.id);
  let bytes;
  if (window.__FT_MAPS__) bytes = b64bytes(window.__FT_MAPS__[t.id]);
  else {
    const r = await fetch(window.__FT_MAPURL__ ? window.__FT_MAPURL__ + t.id : `/api/fortune-teller/map/${t.id}`, { credentials: "same-origin" });
    if (!r.ok) throw new Error("map " + r.status);
    // Read in pieces so a large map shows how far along it is.
    const size = Number(r.headers.get("content-length")) || 0, reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (reader && size) { const parts = []; let got = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; if (onProgress) onProgress(got / size); }
      bytes = new Uint8Array(got); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; } }
    else bytes = new Uint8Array(await r.arrayBuffer());
  }
  // Handed over compressed: the counter inflates it inside its worker (or here, without one).
  return { bytes, root: meta.root, G: data.games.length, leafBase: meta.leafBase || 256, leaves: meta.leaves || null };
}

const root = createRoot(document.getElementById("root"));
const prepare = (data) => {
  if (data && data.ready) {
    const ix = new Map(data.teams.map((t, i) => [t.id, i]));
    data.games.forEach((g) => { g.ai = ix.get(g.a); g.bi = ix.get(g.b); g.aName = data.teams[g.ai].name; g.bName = data.teams[g.bi].name; });
  }
  return data;
};
root.render(<FortuneTeller data={null} />);
(async () => {
  let data = window.__FT_PREVIEW__ || null;
  try {
    if (!data) { const r = await fetch("/api/fortune-teller", { credentials: "same-origin" }); data = await r.json(); }
  } catch (e) { data = { ok: false, ready: false, error: String(e) }; }
  prepare(data);
  window.__FT_SEEN__ = { ready: !!(data && data.ready), teams: data && data.teams ? data.teams.length : 0, trim: data ? data.activeTrim ?? null : null };
  const load = (i, onP) => fetchMap(data, i, onP);
  root.render(<FortuneTeller data={data} loadMap={load} />);
  // While something is being built or updated, check back every 30 seconds: a first map
  // appears by itself; a newer map over one being read is offered, not forced.
  if (window.__FT_PREVIEW__) return;
  let current = data;
  setInterval(async () => {
    // Only while a build or an update is running: weeks before one can start, there is nothing to wait for.
    const st = current && current.pipeline && current.pipeline.state;
    if (!["building", "updating"].includes(st)) return;
    try {
      const fresh = prepare(await (await fetch("/api/fortune-teller", { credentials: "same-origin" })).json());
      if (!current.ready) { current = fresh; root.render(<FortuneTeller data={fresh} loadMap={(i, onP) => fetchMap(fresh, i, onP)} />); return; }
      const changed = fresh.ready && (fresh.updatedAt || fresh.builtAt) !== (current.updatedAt || current.builtAt);
      current = { ...current, pipeline: fresh.pipeline };
      root.render(<FortuneTeller data={data} loadMap={load} live={{ pipeline: fresh.pipeline, changed }} />);
    } catch (e) { /* try again next time */ }
  }, 30000);
})();
