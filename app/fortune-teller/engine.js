import { makeRules, seedPath } from "./seeding.js";
// Fortune Teller engine for the design sample. Plain module: no React, no DOM,
// so it can be tested by behaviour and shared by the server and the browser.
//
// A path is one digit per remaining game, in the fixed game order:
//   0 = the teams tie, 1 = team A (home) wins, 2 = team B (away) wins.
// A team map is a merged decision diagram over those digits. Ids below 256 are
// leaves carrying the team's finishing block (start * 16 + size); node k has id
// 256 + k and is stored as four ints [game, ifTie, ifA, ifB], children first.

export const DIGITS = [1, 0, 2]; // display order: team A, tie, team B

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Win points (2 per win, 1 per tie) for every team after applying a path. */
export function winPoints(data, path) {
  const wp = data.teams.map((t) => 2 * t.w + t.t);
  data.games.forEach((g, j) => {
    const d = path[j];
    if (d === 0) { wp[g.ai] += 1; wp[g.bi] += 1; } else if (d === 1) wp[g.ai] += 2; else wp[g.bi] += 2;
  });
  return wp;
}

/** The finishing block of one team on a path: first place (0-based) and size. */
export function rulesOf(data) { if (!data.__rules) Object.defineProperty(data, "__rules", { value: makeRules(data), enumerable: false }); return data.__rules; }
export function blockOf(data, path, ti) {
  const rules = rulesOf(data);
  if (!rules.fast) { const t = seedPath(data, rules, path, null).team[ti]; return { start: t.start, size: t.size, counts: t.counts, total: t.total }; }
  const wp = winPoints(data, path);
  let above = 0, level = 0;
  for (let i = 0; i < wp.length; i++) { if (wp[i] > wp[ti]) above++; else if (wp[i] === wp[ti]) level++; }
  return { start: above, size: level };
}

export function classify(block, places) {
  if (block.start + block.size <= places) return 'in';
  if (block.start >= places) return 'out';
  return 'cut';
}

export function placeLabel(block) {
  return (block.size > 1 ? 'T-' : '') + ordinal(block.start + 1);
}

/**
 * Full final standings for a path. Teams level on record stay a block; inside a
 * block the member's chosen order wins, otherwise today's points order them.
 */
export function standings(data, path, pf, tieOrders) {
  if (!rulesOf(data).fast) return standingsByRules(data, path, pf, tieOrders);
  const wp = winPoints(data, path);
  const rec = data.teams.map((t) => ({ w: t.w, l: t.l, t: t.t }));
  data.games.forEach((g, j) => {
    const d = path[j], a = rec[g.ai], b = rec[g.bi];
    if (d === 0) { a.t++; b.t++; } else if (d === 1) { a.w++; b.l++; } else { b.w++; a.l++; }
  });
  const byWp = new Map();
  data.teams.forEach((t, i) => { const k = wp[i]; if (!byWp.has(k)) byWp.set(k, []); byWp.get(k).push(i); });
  const levels = [...byWp.keys()].sort((x, y) => y - x);
  const rows = []; const blocks = [];
  let start = 0;
  for (const lv of levels) {
    const members = byWp.get(lv);
    const key = members.map((i) => data.teams[i].id).sort((x, y) => x - y).join('-');
    let order = members.slice().sort((x, y) => pf[y] - pf[x]);
    const chosen = tieOrders && tieOrders[key];
    if (chosen && chosen.length === members.length && chosen.every((id) => members.some((i) => data.teams[i].id === id))) {
      order = chosen.map((id) => data.teams.findIndex((t) => t.id === id));
    }
    const block = { key, start, size: members.length, members: order, chosen: !!chosen };
    blocks.push(block);
    order.forEach((ti, k) => rows.push({ ti, team: data.teams[ti], seed: start + k + 1, block, record: rec[ti],
      wp: lv, label: placeLabel({ start, size: members.length }) }));
    start += members.length;
  }
  return { rows, blocks };
}

/**
 * Standings under the league's full rules: blocks are only where points still
 * decide, and a member's chosen order is kept only if the rules can produce it.
 */
function standingsByRules(data, path, pf, tieOrders) {
  const res = seedPath(data, rulesOf(data), path, pf), wp = winPoints(data, path);
  const rec = data.teams.map((t) => ({ w: t.w, l: t.l, t: t.t }));
  data.games.forEach((g, j) => { const d = path[j], a = rec[g.ai], b = rec[g.bi]; if (d === 0) { a.t++; b.t++; } else if (d === 1) { a.w++; b.l++; } else { b.w++; a.l++; } });
  const rows = [], blocks = [];
  for (const b0 of res.blocks) {
    const key = b0.members.map((i) => data.teams[i].id).sort((x, y) => x - y).join('-');
    let order = b0.members.slice(); const chosen = tieOrders && tieOrders[key];
    if (chosen && chosen.length === order.length) {
      const idx = chosen.map((id) => data.teams.findIndex((t) => t.id === id));
      if (idx.every((i) => i >= 0 && order.includes(i)) && (!b0.orders || b0.orders.some((o) => o.join() === idx.join()))) order = idx;
    }
    const block = { key, start: b0.start, size: b0.size, members: order, chosen: order !== b0.members, orders: b0.orders };
    blocks.push(block);
    order.forEach((ti, k) => rows.push({ ti, team: data.teams[ti], seed: b0.start + k + 1, block, record: rec[ti], wp: wp[ti], label: placeLabel(b0) }));
  }
  return { rows, blocks, approx: res.approx };
}

/** Bracket slots from a seeding (array of team indexes, best first). */
export function brackets(seeds, places, consolation) {
  const s = (n) => (n <= seeds.length ? { seed: n, ti: seeds[n - 1] } : null);
  const winners = places === 4
    ? [{ id: 'sf1', round: 'Semifinal', a: s(1), b: s(4) }, { id: 'sf2', round: 'Semifinal', a: s(2), b: s(3) }]
    : [];
  const later = places === 4 ? [
    { id: 'final', round: 'Final', a: { from: 'Winner', of: 'sf1' }, b: { from: 'Winner', of: 'sf2' } },
    { id: 'third', round: 'Third place', a: { from: 'Loser', of: 'sf1' }, b: { from: 'Loser', of: 'sf2' } },
  ] : [];
  const rest = [];
  for (let n = places + 1; n + 1 <= seeds.length; n += 2) rest.push({ id: 'c' + n, round: 'Round 1', a: s(n), b: s(n + 1) });
  const ladder = consolation && rest.length === 3 ? [
    { id: 'p5', round: '5th place', a: { from: 'Winner', of: rest[0].id }, b: { from: 'Winner', of: rest[1].id } },
    { id: 'p7', round: '7th place', a: { from: 'Loser', of: rest[0].id }, b: { from: 'Winner', of: rest[2].id } },
    { id: 'p9', round: '9th place', a: { from: 'Loser', of: rest[1].id }, b: { from: 'Loser', of: rest[2].id } },
  ] : [];
  return { winners, later, consolation: consolation ? rest : [], ladder };
}

/**
 * Exact counts from one team's map under a set of pinned games.
 * pins[j] = -1 (open) or the digit it is held to. Every path counts once and a
 * tie block's places are shared evenly (scheme A).
 * Returns the totals and, for every game and digit, the paths and playoff share
 * through that result: one pass down, one pass up.
 */
/** A leaf: the team's block and, where the rules make it uneven, how often it lands on each place. */
export function leafInfo(map, x) {
  if (map.leaves) return map.leaves[x];
  return { start: x >> 4, size: x & 15, counts: null, total: 1 };
}
const leafClinched = (map, x, places) => { const L = leafInfo(map, x); if (!L.counts) return L.start + L.size <= places; for (let i = 0; i < L.size; i++) if (L.counts[i] > 0 && L.start + i >= places) return false; return true; };

export function mapCounts(map, pins, places, nTeams) {
  const r = countAll(map, pins, places, nTeams), G = map.G;
  const M = Array.from({ length: G }, (_, j) => [0, 1, 2].map((d) => (pins[j] >= 0 && pins[j] !== d ? [0, 0] : [r.M[6 * j + 2 * d], r.M[6 * j + 2 * d + 1]])));
  return { total: Array.from(r.total), M };
}

/** Odds for each result of one set game, holding every other set result: one pass, no recount. */
export function alternativesFor(map, pins, j, places, nTeams) {
  const r = countAll(map, pins, places, 0);
  return [0, 1, 2].map((d) => [r.M[6 * j + 2 * d], r.M[6 * j + 2 * d + 1]]);
}

export function pct(share, paths) {
  if (!paths) return '–';
  const v = (100 * share) / paths;
  if (v > 0 && v < 0.1) return '<0.1%';
  if (v < 100 && v > 99.9) return '>99.9%';
  return (Math.round(v * 10) / 10).toFixed(v === 0 || v === 100 ? 0 : 1) + '%';
}

/** Whether every path the pins allow leaves the team wholly inside the playoff places. */
export function clinchedUnder(map, pins, places, work) {
  const { nodes, root } = map, memo = new Map();
  const ok = (x) => {
    const LB = map.leafBase || 256;
    if (x < LB) return leafClinched(map, x, places);
    let v = memo.get(x); if (v !== undefined) return v;
    const k = x - LB, j = nodes[4 * k]; v = true;
    for (let d = 0; d < 3; d++) { if (pins[j] >= 0 && pins[j] !== d) continue; if (!ok(nodes[4 * k + 1 + d])) { v = false; break; } }
    memo.set(x, v); return v;
  };
  const r = ok(root); if (work) work.n += memo.size; return r;
}

/** The games that can still change anything for the team, given the pins. */
export function supportUnder(map, pins) {
  const { nodes, root } = map, seen = new Set(), vars = new Set(), stack = [root];
  while (stack.length) {
    const LB = map.leafBase || 256;
    const x = stack.pop(); if (x < LB || seen.has(x)) continue; seen.add(x);
    const k = x - LB, j = nodes[4 * k]; vars.add(j);
    for (let d = 0; d < 3; d++) if (!(pins[j] >= 0 && pins[j] !== d)) stack.push(nodes[4 * k + 1 + d]);
  }
  return vars;
}

/**
 * The simplest path: the fewest wins and losses (never a tie) after which the team
 * is in the playoffs whatever else happens, ties included. Exact up to maxK
 * results by iterative deepening, trying the team's own games first; a time budget
 * keeps it from ever stalling the page.
 */
export function simplestPath(map, pins0, places, { order, prefer, maxK = 6, budgetMs = 400, maxSteps = Infinity, maxWork = Infinity, now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) }) {
  if (clinchedUnder(map, pins0, places)) return { k: 0, set: [] };
  const t0 = now(), pins = Int8Array.from(pins0), sup = supportUnder(map, pins0);
  const cand = order.filter((j) => pins0[j] < 0 && sup.has(j));
  let found = null, timedOut = false, steps = 0; const work = { n: 0 };
  const dfs = (start, left, chosen) => {
    if (++steps > maxSteps || work.n > maxWork || now() - t0 > budgetMs) { timedOut = true; return true; }
    if (clinchedUnder(map, pins, places, work)) { found = chosen.slice(); return true; }
    if (left === 0) return false;
    for (let r = start; r < cand.length; r++) {
      const j = cand[r], first = prefer ? prefer(j) : 1;
      for (const d of [first, 3 - first]) { pins[j] = d; chosen.push([j, d]); if (dfs(r + 1, left - 1, chosen)) return true; chosen.pop(); pins[j] = -1; }
    }
    return false;
  };
  for (let k = 1; k <= maxK && !found && !timedOut; k++) dfs(0, k, []);
  return found ? { k: found.length, set: found } : { k: null, set: null, timedOut };
}

/**
 * Every count the page needs from one pass over a map, whatever its size.
 * Returns the totals (paths, playoff share, and the finish spread when spreadN > 0)
 * and, for every game, the paths and playoff share each result would give while
 * holding every other result that is set. A game that is itself set still gets its
 * alternatives: they come from the same up and down totals, and are never passed on.
 * Skipped games are accumulated with difference arrays, so cost is linear in nodes.
 */
const SCRATCH = { down: null, up: null, up2: null };
function scratch(name, n) { let a = SCRATCH[name]; if (!a || a.length < n) a = SCRATCH[name] = new Float64Array(n); else a.fill(0, 0, n); return a; }

export function countAll(map, pins, places, spreadN = 0) {
  const { nodes, root, G } = map, K = nodes.length / 4, LB = map.leafBase || 256, W = 2 + spreadN;
  const P = new Float64Array(G + 1); P[0] = 1;
  for (let j = 0; j < G; j++) P[j + 1] = P[j] * (pins[j] >= 0 ? 1 : 3);
  const level = (x) => (x < LB ? G : nodes[4 * (x - LB)]);
  const leafVec = new Map();
  const leaf = (x) => {
    let v = leafVec.get(x); if (v) return v;
    v = new Float64Array(W); v[0] = 1; const L = leafInfo(map, x);
    for (let i = 0; i < L.size; i++) { const sh = L.counts ? L.counts[i] / L.total : 1 / L.size, p = L.start + i; if (2 + p < W) v[2 + p] = sh; if (p < places) v[1] += sh; }
    leafVec.set(x, v); return v;
  };
  const down = scratch("down", W * K);
  for (let k = 0; k < K; k++) {
    const v = nodes[4 * k], o = W * k;
    for (let d = 0; d < 3; d++) {
      if (pins[v] >= 0 && pins[v] !== d) continue;
      const c = nodes[4 * k + 1 + d], m = P[level(c)] / P[v + 1];
      if (c < LB) { const cv = leaf(c); for (let q = 0; q < W; q++) down[o + q] += m * cv[q]; }
      else { const oc = W * (c - LB); for (let q = 0; q < W; q++) down[o + q] += m * down[oc + q]; }
    }
  }
  const rootMult = P[level(root)];
  const total = new Float64Array(W);
  if (root < LB) { const rv = leaf(root); for (let q = 0; q < W; q++) total[q] = rootMult * rv[q]; }
  else for (let q = 0; q < W; q++) total[q] = rootMult * down[W * (root - LB) + q];
  const M = new Float64Array(G * 6);                 // [game][result][paths, playoff share]
  const skip0 = new Float64Array(G + 1), skip1 = new Float64Array(G + 1);
  const skipped = (from, to, t0, t1) => { if (from < to) { skip0[from] += t0; skip0[to] -= t0; skip1[from] += t1; skip1[to] -= t1; } };
  skipped(0, level(root), total[0], total[1]);
  const up = scratch("up", K);
  if (root >= LB) up[root - LB] = rootMult;
  for (let k = K - 1; k >= 0; k--) {
    const u = up[k]; if (!u) continue;
    const v = nodes[4 * k];
    for (let d = 0; d < 3; d++) {
      const c = nodes[4 * k + 1 + d], lc = level(c), m = P[lc] / P[v + 1];
      let c0, c1; if (c < LB) { const cv = leaf(c); c0 = cv[0]; c1 = cv[1]; } else { c0 = down[W * (c - LB)]; c1 = down[W * (c - LB) + 1]; }
      const t0 = u * m * c0, t1 = u * m * c1;
      M[6 * v + 2 * d] += t0; M[6 * v + 2 * d + 1] += t1;
      if (pins[v] >= 0 && pins[v] !== d) continue;   // an alternative to a set result: counted, never passed on
      skipped(v + 1, lc, t0, t1);
      if (c >= LB) up[c - LB] += u * m;
    }
  }
  let a0 = 0, a1 = 0;
  for (let j = 0; j < G; j++) {
    a0 += skip0[j]; a1 += skip1[j]; if (!a0 && !a1) continue;
    if (pins[j] >= 0) for (let d = 0; d < 3; d++) { M[6 * j + 2 * d] += a0; M[6 * j + 2 * d + 1] += a1; }
    else for (let d = 0; d < 3; d++) { M[6 * j + 2 * d] += a0 / 3; M[6 * j + 2 * d + 1] += a1 / 3; }
  }
  return { total, M };
}

/**
 * Totals only (paths, playoff share, and the finish spread when spreadN > 0), from one
 * downward pass carrying a single number per node: how many paths reach it. A total is
 * the sum, over every edge into a leaf, of the paths that reach it times what the leaf
 * holds. Memory is one number a node however many places the spread has, so a map of a
 * million nodes costs megabytes, not the hundred-plus a spread per node would.
 */
export function totalsOf(map, pins, places, spreadN = 0) {
  const { nodes, root, G } = map, K = nodes.length / 4, LB = map.leafBase || 256, W = 2 + spreadN;
  const P = new Float64Array(G + 1); P[0] = 1;
  for (let j = 0; j < G; j++) P[j + 1] = P[j] * (pins[j] >= 0 ? 1 : 3);
  const level = (x) => (x < LB ? G : nodes[4 * (x - LB)]);
  const out = new Float64Array(W), cache = new Map();
  const addLeaf = (x, w) => {
    let v = cache.get(x);
    if (!v) { v = new Float64Array(W); v[0] = 1; const L = leafInfo(map, x);
      for (let i = 0; i < L.size; i++) { const sh = L.counts ? L.counts[i] / L.total : 1 / L.size, p = L.start + i; if (2 + p < W) v[2 + p] = sh; if (p < places) v[1] += sh; }
      cache.set(x, v); }
    for (let q = 0; q < W; q++) out[q] += w * v[q];
  };
  const rootMult = P[level(root)];
  if (root < LB) { addLeaf(root, rootMult); return out; }
  const up = scratch("up2", K); up[root - LB] = rootMult;
  for (let k = K - 1; k >= 0; k--) {
    const u = up[k]; if (!u) continue;
    const v = nodes[4 * k];
    for (let d = 0; d < 3; d++) {
      if (pins[v] >= 0 && pins[v] !== d) continue;
      const c = nodes[4 * k + 1 + d], m = P[level(c)] / P[v + 1];
      if (c < LB) addLeaf(c, u * m); else up[c - LB] += u * m;
    }
  }
  return out;
}

/** Each leaf id's playoff share, computed once per map and kept on it. */
function leafShares(map, places) {
  if (map.__ls && map.__lsPlaces === places) return map.__ls;
  const LB = map.leafBase || 256, ls = new Float64Array(LB);
  for (let x = 0; x < LB; x++) {
    if (map.leaves && !map.leaves[x]) continue;
    const L = leafInfo(map, x); let s = 0;
    for (let i = 0; i < L.size; i++) if (L.start + i < places) s += L.counts ? L.counts[i] / L.total : 1 / L.size;
    ls[x] = s;
  }
  Object.defineProperty(map, "__ls", { value: ls, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(map, "__lsPlaces", { value: places, writable: true, configurable: true, enumerable: false });
  return ls;
}

/**
 * What a click needs, as lean as it can be: paths and playoff share in total, and for
 * every game each result's paths and share (a set game's alternatives included). Two
 * plain arrays a node, leaf shares read from a table, every lookup inlined. Same answers
 * as countAll with no spread, several times faster on a large map.
 */
export function countLean(map, pins, places) {
  const nodes = map.nodes, root = map.root, G = map.G, K = nodes.length / 4, LB = map.leafBase || 256;
  const P = new Float64Array(G + 1); P[0] = 1;
  for (let j = 0; j < G; j++) P[j + 1] = P[j] * (pins[j] >= 0 ? 1 : 3);
  const LS = leafShares(map, places), PG = P[G];
  const d0 = scratch("d0", K), d1 = scratch("d1", K);
  for (let k = 0; k < K; k++) {
    const v = nodes[4 * k], pv = pins[v], inv = 1 / P[v + 1]; let a0 = 0, a1 = 0;
    for (let d = 0; d < 3; d++) {
      if (pv >= 0 && pv !== d) continue;
      const c = nodes[4 * k + 1 + d];
      if (c < LB) { const m = PG * inv; a0 += m; a1 += m * LS[c]; }
      else { const ci = c - LB, m = P[nodes[4 * ci]] * inv; a0 += m * d0[ci]; a1 += m * d1[ci]; }
    }
    d0[k] = a0; d1[k] = a1;
  }
  const total = new Float64Array(2);
  const lvRoot = root < LB ? G : nodes[4 * (root - LB)], rootMult = P[lvRoot];
  if (root < LB) { total[0] = rootMult; total[1] = rootMult * LS[root]; } else { total[0] = rootMult * d0[root - LB]; total[1] = rootMult * d1[root - LB]; }
  const M = new Float64Array(G * 6), s0 = new Float64Array(G + 1), s1 = new Float64Array(G + 1);
  if (lvRoot > 0) { s0[0] += total[0]; s0[lvRoot] -= total[0]; s1[0] += total[1]; s1[lvRoot] -= total[1]; }
  const up = scratch("up3", K);
  if (root >= LB) up[root - LB] = rootMult;
  for (let k = K - 1; k >= 0; k--) {
    const u = up[k]; if (!u) continue;
    const v = nodes[4 * k], pv = pins[v], inv = 1 / P[v + 1];
    for (let d = 0; d < 3; d++) {
      const c = nodes[4 * k + 1 + d]; let lc, c0, c1;
      if (c < LB) { lc = G; c0 = 1; c1 = LS[c]; } else { const ci = c - LB; lc = nodes[4 * ci]; c0 = d0[ci]; c1 = d1[ci]; }
      const um = u * P[lc] * inv, t0 = um * c0, t1 = um * c1;
      M[6 * v + 2 * d] += t0; M[6 * v + 2 * d + 1] += t1;
      if (pv >= 0 && pv !== d) continue;
      if (v + 1 < lc) { s0[v + 1] += t0; s0[lc] -= t0; s1[v + 1] += t1; s1[lc] -= t1; }
      if (c >= LB) up[c - LB] += um;
    }
  }
  let a0 = 0, a1 = 0;
  for (let j = 0; j < G; j++) {
    a0 += s0[j]; a1 += s1[j]; if (!a0 && !a1) continue;
    if (pins[j] >= 0) for (let d = 0; d < 3; d++) { M[6 * j + 2 * d] += a0; M[6 * j + 2 * d + 1] += a1; }
    else for (let d = 0; d < 3; d++) { M[6 * j + 2 * d] += a0 / 3; M[6 * j + 2 * d + 1] += a1 / 3; }
  }
  return { total, M };
}
