/* Fortune Teller's counting worker: holds the selected team's map and answers the page's counts off the main thread. */
import { computeState, computeSimplest, inflateMap } from "./counting.js";
let map = null, cache = {};
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === "load") { map = await inflateMap(payload); cache = {}; self.postMessage({ id, out: true }); }
    else if (type === "state") self.postMessage({ id, out: computeState(map, payload, cache) });
    else if (type === "simplest") self.postMessage({ id, out: computeSimplest(map, payload) });
  } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
};
