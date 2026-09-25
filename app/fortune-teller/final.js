import { standings } from "./engine.js";

/**
 * The regular season once every game has been played. Nothing is left to chance, so every
 * team either has a playoff place or does not: the order is the league's own (level teams
 * ordered by the seeding rule, then by points), and the odds are exactly 1 or 0. A plain
 * module, used by the build, the server's Sim % reader and the page.
 */
export function prepared(summary) {
  const ix = new Map(summary.teams.map((t, i) => [t.id, i]));
  return { ...summary, games: summary.games.map((g) => ({ ...g, ai: g.ai ?? ix.get(g.a), bi: g.bi ?? ix.get(g.b) })) };
}

export function isFinal(summary, trim) { return !!summary && !!trim && trim.fixed >= summary.games.length && summary.future.every((f) => f.digit != null); }

/** Team indexes in final order, and each team's final record. */
export function finalOrder(summary, trim) {
  const data = prepared(summary), path = summary.future.map((f) => f.digit);
  const st = standings(data, path, trim.pf);
  return { order: st.blocks.flatMap((b) => b.members), rows: st.rows };
}

/** 1 for each playoff place, 0 for everyone else; null while games remain. */
export function finalOdds(summary, trim) {
  if (!isFinal(summary, trim)) return null;
  const { order } = finalOrder(summary, trim), odds = new Array(summary.teams.length).fill(0);
  order.forEach((ti, k) => { if (k < summary.places) odds[ti] = 1; });
  return odds;
}

/**
 * Standings with nothing left level: once every game is played the points are final, so teams
 * level on record are ordered (by the league's rule, then points) and each gets a place of its own.
 */
export function flattenStandings(st) {
  const flat = st.blocks.flatMap((b) => b.members);
  return { ...st, blocks: flat.map((m, k) => ({ key: `solo-${m}`, start: k, size: 1, members: [m], chosen: false })),
    rows: flat.map((m, k) => ({ ...st.rows.find((r) => r.ti === m), block: { start: k, size: 1 } })) };
}

/** A team's definite place on a fully set path once the points are final. */
export function definiteBlock(data, path, pf, ti) {
  const s = standings(data, path, pf);
  return { start: s.blocks.flatMap((b) => b.members).indexOf(ti), size: 1 };
}
