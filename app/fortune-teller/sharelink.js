/**
 * Fortune Teller share links. A plain module, so the link the button writes is
 * the link the page reads back, and both are tested by behaviour.
 *
 *   ?team=<id>&path=<one digit per game>&set=<indexes the sender set>&wif=1
 *    &ties=<id-id-id_id-id>&ds=<dataset>~<trim>
 *
 * Everything is validated against the data as it stands: a link made for a
 * different dataset or week, or one that rewrites a played game without What-if,
 * is refused rather than half-applied.
 */
export function encodeShare({ teamId, path, pins, fixed, whatIf, tieOrders, dataset, trim }) {
  const q = new URLSearchParams();
  q.set("team", String(teamId));
  q.set("path", path.join(""));
  const set = [];
  for (let j = fixed; j < path.length; j++) if (pins[j] >= 0) set.push(j);
  if (set.length) q.set("set", set.join("."));
  if (whatIf) q.set("wif", "1");
  const ties = Object.values(tieOrders || {}).map((ids) => ids.join("-")).join("_");
  if (ties) q.set("ties", ties);
  if (dataset != null) q.set("ds", `${dataset}~${trim}`);
  return q.toString();
}

export function datasetTag(data) { return data.datasetId ?? data.source ?? "data"; }

export function decodeShare(search, data, trimIdx, actual, allowedDigits = [0, 1, 2]) {
  const q = new URLSearchParams(search || "");
  if (!q.has("path") || !q.has("team")) return null;
  const G = data.games.length;
  const team = data.teams.findIndex((t) => t.id === Number(q.get("team")));
  if (team < 0) return { error: "team" };
  const ds = q.get("ds");
  if (ds && ds !== `${datasetTag(data)}~${trimIdx}`) return { error: "dataset" };
  const digits = q.get("path") || "";
  if (digits.length !== G || [...digits].some((c) => !allowedDigits.includes(Number(c)) || !/[0-9]/.test(c))) return { error: "path" };
  const path = [...digits].map(Number);
  const whatIf = q.get("wif") === "1";
  const fixed = data.trims[trimIdx].fixed;
  if (!whatIf) for (let j = 0; j < fixed; j++) if (path[j] !== actual[j]) return { error: "path" };
  const pins = new Int8Array(G).fill(-1);
  for (let j = 0; j < fixed; j++) pins[j] = path[j];
  for (const s of (q.get("set") || "").split(".").filter(Boolean)) {
    const j = Number(s);
    if (!Number.isInteger(j) || j < fixed || j >= G) return { error: "set" };
    pins[j] = path[j];
  }
  const tieOrders = {};
  for (const grp of (q.get("ties") || "").split("_").filter(Boolean)) {
    const ids = grp.split("-").map(Number);
    if (ids.length < 2 || ids.some((x) => !data.teams.some((t) => t.id === x))) return { error: "ties" };
    tieOrders[[...ids].sort((a, b) => a - b).join("-")] = ids;
  }
  return { team, path, pins, whatIf, tieOrders };
}
