/**
 * ESPN's regular-season seeding, for one complete path. One module, imported by
 * the page and by the Cloudflare build, so the two can never disagree.
 *
 * The process: division winners are seeded first when the league has divisions;
 * then teams order by win percentage (a tie is half a win); teams level on it go
 * through the league's chosen rule and then ESPN's default order (head-to-head,
 * points for, intra-division record, points against, coin flip), restarting from
 * the top after every seed. Head-to-head counts only when every tied team met
 * every other the same number of times.
 *
 * Future points are unknown, so a step decided by points is decided by a points
 * order nobody can see yet. Every such order is equally likely, and since two
 * teams never finish on exactly equal points, points for (always in the chain)
 * settles anything the earlier steps leave. So a path's outcome is found by
 * running the process once per possible points order of the teams it depends on
 * and counting where each team lands. A league whose chosen rule is points-based
 * reduces to even blocks with no enumeration at all.
 */
export const DEFAULT_ORDER = ["H2H_RECORD", "TOTAL_POINTS_SCORED", "INTRA_DIVISION_RECORD", "TOTAL_POINTS_AGAINST"];
export const POINTS_RULES = new Set(["TOTAL_POINTS_SCORED", "TOTAL_POINTS_AGAINST"]);
export const ENUM_CAP = 7;

/** The league's rules, normalised, plus everything a path needs that the path does not change. */
export function makeRules(data) {
  const n = data.teams.length, ix = new Map(data.teams.map((t, i) => [t.id, i]));
  const primary = DEFAULT_ORDER.includes(data.seedingRule) ? data.seedingRule : "TOTAL_POINTS_SCORED";
  const chain = [primary, ...DEFAULT_ORDER.filter((r) => r !== primary)];
  const div = data.teams.map((t) => (data.divisions && data.divisions[t.id] != null ? String(data.divisions[t.id]) : "0"));
  const divCount = new Set(div).size;
  // Meetings over the whole regular season (played games and the window alike), and results so far.
  const meet = new Int16Array(n * n), h2h = new Int16Array(n * n), divPts = new Int32Array(n), divGames = new Int32Array(n);
  const add = (a, b, res, count) => {
    if (count) { meet[a * n + b]++; meet[b * n + a]++; if (div[a] === div[b]) { divGames[a]++; divGames[b]++; } }
    if (res == null) return;
    const pa = res === 0 ? 1 : res === 1 ? 2 : 0, pb = 2 - pa;
    h2h[a * n + b] += pa; h2h[b * n + a] += pb;
    if (div[a] === div[b]) { divPts[a] += pa; divPts[b] += pb; }
  };
  for (const g of data.played || []) { const a = ix.get(g.a), b = ix.get(g.b); if (a != null && b != null) add(a, b, g.res, true); }
  const games = data.games.map((g) => [ix.get(g.a), ix.get(g.b)]);
  for (const [a, b] of games) add(a, b, null, true);
  const fast = POINTS_RULES.has(primary) && divCount < 2;
  return { n, primary, chain, div, divCount, meet, h2h, divPts, divGames, games, fast, hasHistory: Boolean(data.played && data.played.length) };
}

/** Win points, head-to-head and division points for one path. */
export function pathState(data, rules, path) {
  const { n, games } = rules;
  const wp = Int32Array.from(data.teams, (t) => 2 * t.w + t.t), h2h = Int16Array.from(rules.h2h), divPts = Int32Array.from(rules.divPts);
  for (let j = 0; j < games.length; j++) {
    const [a, b] = games[j], d = path[j]; if (d == null || d < 0) continue;
    const pa = d === 0 ? 1 : d === 1 ? 2 : 0, pb = 2 - pa;
    wp[a] += pa; wp[b] += pb; h2h[a * n + b] += pa; h2h[b * n + a] += pb;
    if (rules.div[a] === rules.div[b]) { divPts[a] += pa; divPts[b] += pb; }
  }
  return { wp, h2h, divPts };
}

function bestBy(rule, S, rules, st, pfRank) {
  const n = rules.n;
  if (rule === "H2H_RECORD") {
    if (S.length < 2) return S;
    const c = rules.meet[S[0] * n + S[1]]; if (!c) return S;
    for (let x = 0; x < S.length; x++) for (let y = x + 1; y < S.length; y++) if (rules.meet[S[x] * n + S[y]] !== c) return S;
    const v = S.map((a) => S.reduce((s, b) => (b === a ? s : s + st.h2h[a * n + b]), 0));
    const m = Math.max(...v); return S.filter((a, k) => v[k] === m);
  }
  if (rule === "INTRA_DIVISION_RECORD") {
    // Division win percentage, compared exactly by cross-multiplying.
    let best = [];
    for (const a of S) {
      if (!best.length) { best = [a]; continue; }
      const b = best[0], lhs = st.divPts[a] * Math.max(1, rules.divGames[b]), rhs = st.divPts[b] * Math.max(1, rules.divGames[a]);
      if (lhs > rhs) best = [a]; else if (lhs === rhs) best.push(a);
    }
    return best;
  }
  // Points for or against: the hypothetical points order decides.
  let top = S[0]; for (const a of S) if (pfRank[a] < pfRank[top]) top = a; return [top];
}

/** Order one set of teams level on win points, for one points order. */
export function resolveTied(G, rules, st, pfRank) {
  const out = [], R = G.slice();
  while (R.length) {
    let S = R.slice();
    for (const rule of rules.chain) { if (S.length === 1) break; S = bestBy(rule, S, rules, st, pfRank); }
    const top = S[0]; out.push(top); R.splice(R.indexOf(top), 1);
  }
  return out;
}

function orderTeams(T, rules, st, pfRank) {
  const byWp = T.slice().sort((a, b) => st.wp[b] - st.wp[a]), out = [];
  for (let k = 0; k < byWp.length;) {
    let e = k + 1; while (e < byWp.length && st.wp[byWp[e]] === st.wp[byWp[k]]) e++;
    const G = byWp.slice(k, e);
    out.push(...(G.length === 1 ? G : resolveTied(G, rules, st, pfRank)));
    k = e;
  }
  return out;
}

/** With divisions: each division's best win points this path. */
export function divisionContext(rules, st) {
  const divs = [...new Set(rules.div)], divMax = new Map(divs.map((d) => [d, -Infinity]));
  for (let i = 0; i < rules.n; i++) { const d = rules.div[i]; if (st.wp[i] > divMax.get(d)) divMax.set(d, st.wp[i]); }
  return { divs, divMax, D: divs.length };
}
/** How many division winners, and how many other teams, finish above a total of v. */
export function unitOffsets(rules, st, v, dc) {
  let winAbove = 0; for (const d of dc.divs) if (dc.divMax.get(d) > v) winAbove++;
  let above = 0; for (let i = 0; i < rules.n; i++) if (st.wp[i] > v) above++;
  return { winAbove, restAbove: above - winAbove };
}
/** One unit (teams level on v) for one points order: its division winners, then the rest. */
export function unitOutcome(rules, st, members, v, dc, rank) {
  const win = [];
  for (const d of dc.divs) {
    if (dc.divMax.get(d) !== v) continue;
    const T = members.filter((t) => rules.div[t] === d); if (!T.length) continue;
    win.push(T.length > 1 ? resolveTied(T, rules, st, rank)[0] : T[0]);
  }
  const rest = members.filter((t) => !win.includes(t));
  return { win: win.length > 1 ? resolveTied(win, rules, st, rank) : win, rest: rest.length > 1 ? resolveTied(rest, rules, st, rank) : rest };
}
export function unitPlaces(oc, off, dc) {
  const m = new Map(); oc.win.forEach((t, k) => m.set(t, off.winAbove + k)); oc.rest.forEach((t, k) => m.set(t, dc.D + off.restAbove + k)); return m;
}

/** The full seeding for one points order. */
function seedOnce(rules, st, pfRank) {
  const all = Array.from({ length: rules.n }, (_, i) => i);
  if (rules.divCount < 2) return orderTeams(all, rules, st, pfRank);
  const divs = [...new Set(rules.div)];
  const winners = divs.map((d) => orderTeams(all.filter((i) => rules.div[i] === d), rules, st, pfRank)[0]);
  const rest = all.filter((i) => !winners.includes(i));
  return [...orderTeams(winners, rules, st, pfRank), ...orderTeams(rest, rules, st, pfRank)];
}

export function permutations(a) {
  if (a.length <= 1) return [a.slice()];
  const out = [];
  a.forEach((x, i) => { for (const p of permutations([...a.slice(0, i), ...a.slice(i + 1)])) out.push([x, ...p]); });
  return out;
}

/**
 * The outcome of one path: for each team the block of places it can occupy and how
 * often it lands on each, and for each block the orders the rules can actually
 * produce. `pfNow` (points so far) picks the order shown when nothing else does.
 * Without divisions, groups on different win points never interact, so each is
 * enumerated on its own; with divisions the winners couple them, so the tied teams
 * are enumerated together (up to ENUM_CAP; beyond it, the rest keep today's points
 * order and the result is marked approximate).
 */
export function seedPath(data, rules, path, pfNow) { return seedState(rules, pathState(data, rules, path), pfNow); }

export function seedState(rules, st, pfNow) {
  const n = rules.n;
  const nowRank = new Int32Array(n);
  Array.from({ length: n }, (_, i) => i).sort((a, b) => (pfNow ? pfNow[b] - pfNow[a] : 0) || a - b).forEach((t, r) => { nowRank[t] = r; });
  const shown = seedOnce(rules, st, nowRank);
  const team = new Array(n), blocks = []; let approx = false;
  const rankWith = (perm) => { const rank = Int32Array.from(nowRank); perm.forEach((t, r) => { rank[t] = -n + r; }); return rank; };
  if (rules.divCount < 2) {
    for (let k = 0; k < n;) {
      let e = k + 1; while (e < n && st.wp[shown[e]] === st.wp[shown[k]]) e++;
      const G = shown.slice(k, e);
      if (G.length === 1 || rules.fast) { G.forEach((t) => { team[t] = { start: k, size: G.length, counts: null, total: 1 }; }); blocks.push({ start: k, size: G.length, members: G, orders: null }); }
      else {
        let perms; if (G.length > ENUM_CAP) { approx = true; perms = [G]; } else perms = permutations(G);
        const outs = perms.map((perm) => resolveTied(G, rules, st, rankWith(perm)));
        const r = blocksFrom(G, outs, k); r.team.forEach((v, t) => { team[t] = v; }); blocks.push(...r.blocks);
      }
      k = e;
    }
  } else {
    // Divisions: each group of teams level on win points is its own unit. A division's
    // winner comes from its top group, and how many winners and other teams sit above
    // any total is known without points, so units never affect one another.
    const dc = divisionContext(rules, st), per = [], fullMaps = [new Map()];
    for (const v of [...new Set(Array.from(st.wp))].sort((x, y) => y - x)) {
      const members = []; for (let i = 0; i < n; i++) if (st.wp[i] === v) members.push(i);
      const off = unitOffsets(rules, st, v, dc);
      let perms = [null];
      if (members.length > 1) { if (members.length > ENUM_CAP) approx = true; else perms = permutations(members); }
      const outs = perms.map((p) => unitPlaces(unitOutcome(rules, st, members, v, dc, p ? rankWith(p) : nowRank), off, dc));
      per.push({ members, outs });
      const next = [];
      for (const fm of fullMaps) for (const o of outs) { const m = new Map(fm); o.forEach((pos, t) => m.set(t, pos)); next.push(m); if (next.length > 5040) break; }
      if (next.length > 5040) approx = true;
      fullMaps.splice(0, fullMaps.length, ...next.slice(0, 5040));
    }
    const orders = fullMaps.map((m) => { const arr = new Array(n); m.forEach((pos, t) => { arr[pos] = t; }); return arr; });
    const r = blocksFrom(shown, orders, 0); blocks.push(...r.blocks);
    // Each team's own place counts come from its unit alone, so they stay exact.
    for (const { members, outs } of per) for (const t of members) {
      let lo = Infinity, hi = -Infinity; for (const o of outs) { const q = o.get(t); lo = Math.min(lo, q); hi = Math.max(hi, q); }
      let counts = null; if (hi > lo) { counts = new Array(hi - lo + 1).fill(0); for (const o of outs) counts[o.get(t) - lo]++; }
      team[t] = { start: lo, size: hi - lo + 1, counts, total: outs.length };
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  return { order: shown, team, blocks, approx };
}

/** Blocks, place counts and reachable orders for a run of places, from the orders produced. */
export function blocksFrom(shownRun, outs, offset) {
  const lo = new Map(), hi = new Map();
  for (const o of outs) o.forEach((t, p) => { lo.set(t, Math.min(lo.get(t) ?? Infinity, p)); hi.set(t, Math.max(hi.get(t) ?? -Infinity, p)); });
  const spans = shownRun.map((t) => [lo.get(t), hi.get(t)]).sort((a, b) => a[0] - b[0]), merged = [];
  for (const [a, b] of spans) { const c = merged[merged.length - 1]; if (c && a <= c[1]) c[1] = Math.max(c[1], b); else merged.push([a, b]); }
  const uniq = (list) => [...new Map(list.map((o) => [o.join(","), o])).values()];
  const team = new Map(), blocks = [];
  for (const [a, b] of merged) {
    const size = b - a + 1, members = shownRun.slice(a, b + 1);
    for (const t of members) {
      let counts = null;
      if (size > 1) { counts = new Array(size).fill(0); for (const o of outs) counts[o.indexOf(t) - a]++; }
      team.set(t, { start: offset + a, size, counts, total: outs.length });
    }
    blocks.push({ start: offset + a, size, members, orders: size > 1 ? uniq(outs.map((o) => o.slice(a, b + 1))) : null });
  }
  return { team, blocks };
}

/** A team's share of each place in its block, and whether it is even. */
export function placeShares(tr) {
  if (!tr.counts) return { even: true, shares: new Array(tr.size).fill(1 / tr.size) };
  const s = tr.counts.map((c) => c / tr.total);
  return { even: s.every((v) => Math.abs(v - 1 / tr.size) < 1e-12), shares: s };
}
