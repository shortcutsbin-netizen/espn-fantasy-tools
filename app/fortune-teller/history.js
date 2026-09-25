/**
 * ESPN's playoff odds as the site recorded them, one entry per settled week (week 0 is before
 * any game), turned into chart points for one team. A plain module, tested by behaviour.
 * `before` keeps only the weeks the simulation does not cover, so the two never overlap.
 */
export function espnPoints(history, teamId, before = Infinity) {
  if (!history || !history.weeks) return [];
  return Object.keys(history.weeks).map(Number).filter((w) => Number.isFinite(w) && w < before).sort((a, b) => a - b)
    .map((w) => ({ week: w, v: history.weeks[String(w)][teamId], kind: "espn" }))
    .filter((p) => typeof p.v === "number");
}

/** The order the brackets seed teams in: the standings, or ESPN's playoff odds (the standings break ties). */
export function seedOrder(teams, by) {
  const idx = teams.map((t, i) => i).sort((a, b) => (teams[a].rank || 99) - (teams[b].rank || 99));
  if (by !== "espn") return idx;
  return idx.slice().sort((a, b) => ((teams[b].playoffPct ?? -1) - (teams[a].playoffPct ?? -1)) || ((teams[a].rank || 99) - (teams[b].rank || 99)));
}
