/**
 * Fortune Teller's build engine. Plain module: no bindings, testable in Node.
 *
 * A build is one slice per team. Each slice walks every path of the window
 * (3 results a game: 0 tie, 1 team A wins, 2 team B wins), records the team's
 * finishing block for every path, reduces that to the team's map, and picks the
 * team's default path for every trim. Slices are independent, so a build can be
 * resumed from any team and never holds more than one team's table in memory.
 */
import { simplestPath } from '../app/fortune-teller/engine.js';
import { makeRules, resolveTied, permutations, blocksFrom, ENUM_CAP, divisionContext, unitOffsets, unitOutcome } from '../app/fortune-teller/seeding.js';

export const RESULTS_PER_GAME = 3;
export const PATH_CEILING = 3 ** 24;   // what a build may attempt at all; the estimator judges time and memory
export const PART_CEILING = 2 ** 24;   // paths one part may hold in memory
const NO_LEAD = 1e15;                  // 'no tie to break': finite, so it survives JSON

export const pathCount = (input) => RESULTS_PER_GAME ** input.games.length;

/** One team's whole build in one go: a single part, finished. */
export function buildTeam(input, ti) {
  return finishTeam(input, ti, [buildTeamPart(input, ti, 0, 0)], 0);
}

/**
 * One part of a team's build: the paths whose first k games have the results in
 * the base-3 digits of c. A team split into 3^k parts can be built across slices
 * and merged, so no slice holds the whole team or runs long.
 */
export function buildTeamPart(input, ti, k, c, opts = {}) {
  const rules = makeRules(input);
  return rules.fast ? scanFast(input, ti, k, c, opts) : buildTeamGeneral(input, ti, rules, k, c, opts);
}

function scanFast(input, ti, k, c, opts = {}) {
  const teams = input.teams, n = teams.length, G = input.games.length, NP = RESULTS_PER_GAME ** (G - k), base = c * NP;
  if (NP > PART_CEILING) throw new Error(`a part of ${NP} paths is over the part ceiling`);
  const ix = new Map(teams.map((t, i) => [t.id, i]));
  const A = Int32Array.from(input.games, (g) => ix.get(g.a)), B = Int32Array.from(input.games, (g) => ix.get(g.b));
  const wp = Int32Array.from(teams, (t) => 2 * t.w + t.t);
  const add = (j, d, s) => { if (d === 0) { wp[A[j]] += s; wp[B[j]] += s; } else if (d === 1) wp[A[j]] += 2 * s; else wp[B[j]] += 2 * s; };
  const dig = new Int8Array(G); { let cc = c; for (let j = k - 1; j >= 0; j--) { dig[j] = cc % 3; cc = Math.floor(cc / 3); } }
  for (let j = 0; j < G; j++) add(j, dig[j], 1);
  let ties = 0; for (let j = 0; j < G; j++) if (dig[j] === 0) ties++;
  // A trim's paths are one contiguous range, because settled weeks are the leading digits.
  const trims = (input.trims || []).map((tr) => {
    let pre = 0; for (let j = 0; j < tr.fixed; j++) pre = pre * 3 + input.future[j].digit;
    const span = RESULTS_PER_GAME ** (G - tr.fixed);
    return { lo: pre * span, hi: pre * span + span, pf: tr.pf, best: null, pl: 0, n: 0 };
  });
  const leaf = new Uint8Array(NP), fin = new Float64Array(n);
  for (let x = 0; x < NP; x++) {
    const X = base + x;
    if (x > 0) { let j = G - 1; while (dig[j] === 2) { add(j, 2, -1); add(j, 0, 1); dig[j] = 0; ties++; j--; } add(j, dig[j], -1); if (dig[j] === 0) ties--; dig[j]++; add(j, dig[j], 1); }
    const w = wp[ti]; let above = 0, level = 0;
    for (let q = 0; q < n; q++) { const v = wp[q]; if (v > w) above++; else if (v === w) level++; }
    leaf[x] = above * 16 + level;
    for (let p = above; p < above + level; p++) fin[p] += 1 / level;
    for (let q = 0; q < trims.length; q++) {
      const tr = trims[q]; if (X < tr.lo || X >= tr.hi) continue;
      tr.n++; tr.pl += Math.max(0, Math.min(input.places, above + level) - above) / level;   // this week's odds, counted as we pass
      const b = tr.best;
      if (b && (above > b.s || (above === b.s && level > b.k))) continue;
      let lead = NO_LEAD;
      if (level > 1) { let m = -Infinity; for (let q = 0; q < n; q++) if (q !== ti && wp[q] === w && tr.pf[q] > m) m = tr.pf[q]; lead = tr.pf[ti] - m; }
      if (!b || above < b.s || level < b.k || lead > b.lead || (lead === b.lead && ties < b.ties)) tr.best = { s: above, k: level, lead, ties, x: X };
    }
  }
  const { nodes, root } = opts.scanOnly ? { nodes: new Int32Array(0), root: 0 } : reduceLeaves(leaf, G, 256, k);
  return { nodes, root, LB: 256, leaves: null, fin: Array.from(fin), best: trims.map((t) => t.best), trimOdds: trims.map((t) => [t.pl, t.n]), paths: NP };
}

/**
 * Bottom-up reduction of a leaf table into a map. Reads the table in place (no copy),
 * and deduplicates with a numeric open-addressing table over typed arrays: about 24
 * bytes a node, where string keys in a Map cost several times that. A part whose
 * diagram is unusually large must still fit in a Durable Object's 128 MB.
 */
export function reduceLeaves(leaf, G, LB, kStart = 0) {
  let src = leaf, buf = new Int32Array(1 << 16), used = 0;
  const hash = (a, b, c) => { let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b); h = Math.imul(h ^ b, 0xc2b2ae35); h = Math.imul(h ^ c, 0x27d4eb2f); return (h ^ (h >>> 15)) >>> 0; };
  for (let j = G - 1; j >= kStart; j--) {
    const len = src.length / 3, out = new Int32Array(len), levelStart = used;
    let cap = 1 << 12, slots = new Int32Array(cap).fill(-1);
    const rehash = () => { cap *= 2; slots = new Int32Array(cap).fill(-1);
      for (let q = levelStart; q < used; q++) { let i = hash(buf[4 * q + 1], buf[4 * q + 2], buf[4 * q + 3]) & (cap - 1); while (slots[i] !== -1) i = (i + 1) & (cap - 1); slots[i] = q; } };
    for (let k = 0; k < len; k++) {
      const a = src[3 * k], b = src[3 * k + 1], c = src[3 * k + 2];
      if (a === b && b === c) { out[k] = a; continue; }
      let i = hash(a, b, c) & (cap - 1), q = -1;
      while (slots[i] !== -1) { const r = slots[i]; if (buf[4 * r + 1] === a && buf[4 * r + 2] === b && buf[4 * r + 3] === c) { q = r; break; } i = (i + 1) & (cap - 1); }
      if (q < 0) {
        q = used++;
        if (4 * used > buf.length) { const nb = new Int32Array(buf.length * 2); nb.set(buf); buf = nb; }
        buf[4 * q] = j; buf[4 * q + 1] = a; buf[4 * q + 2] = b; buf[4 * q + 3] = c; slots[i] = q;
        if ((used - levelStart) * 2 > cap) rehash();
      }
      out[k] = LB + q;
    }
    src = out;
  }
  return { nodes: buf.slice(0, 4 * used), root: src[0] };
}

/**
 * A team's slice under the full seeding rules. Leaves are an index into a table of
 * "block, and how often the team lands on each of its places". Without divisions
 * only the team's own group matters, memoised on everything that can change its
 * outcome (members, their head-to-head results, their division points). With
 * divisions the whole table is seeded, memoised on the full state.
 */
function buildTeamGeneral(input, ti, rules, k = 0, c = 0, opts = {}) {
  const teams = input.teams, n = teams.length, G = input.games.length, NP = RESULTS_PER_GAME ** (G - k), base = c * NP;
  if (NP > PART_CEILING) throw new Error(`a part of ${NP} paths is over the part ceiling`);
  const games = rules.games, sameDiv = games.map(([a, b]) => rules.div[a] === rules.div[b]);
  const st = { wp: Int32Array.from(teams, (t) => 2 * t.w + t.t), h2h: Int16Array.from(rules.h2h), divPts: Int32Array.from(rules.divPts) };
  const apply = (j, d, s) => {
    const [a, b] = games[j], pa = d === 0 ? 1 : d === 1 ? 2 : 0, pb = 2 - pa;
    st.wp[a] += pa * s; st.wp[b] += pb * s; st.h2h[a * n + b] += pa * s; st.h2h[b * n + a] += pb * s;
    if (sameDiv[j]) { st.divPts[a] += pa * s; st.divPts[b] += pb * s; }
  };
  const dig = new Int8Array(G); { let cc = c; for (let j = k - 1; j >= 0; j--) { dig[j] = cc % 3; cc = Math.floor(cc / 3); } }
  for (let j = 0; j < G; j++) apply(j, dig[j], 1);
  let ties = 0; for (let j = 0; j < G; j++) if (dig[j] === 0) ties++;
  const table = [], ids = new Map();
  const leafId = (start, size, counts, total) => {
    const even = !counts || counts.every((c) => c * size === total);
    const key = even ? `${start},${size}` : `${start},${size},${counts.join(".")}/${total}`;
    let id = ids.get(key);
    if (id === undefined) { id = table.length; ids.set(key, id); table.push(even ? { start, size, counts: null, total: 1 } : { start, size, counts: counts.slice(), total }); }
    return id;
  };
  const trims = (input.trims || []).map((tr) => {
    let pre = 0; for (let j = 0; j < tr.fixed; j++) pre = pre * 3 + input.future[j].digit;
    const span = RESULTS_PER_GAME ** (G - tr.fixed);
    return { lo: pre * span, hi: pre * span + span, pf: tr.pf, best: null, pl: 0, n: 0 };
  });
  const leaf = new Uint16Array(NP), fin = new Float64Array(n), memo = new Map(), members = [];
  const rankBase = new Int32Array(n);
  for (let x = 0; x < NP; x++) {
    const X = base + x;
    if (x > 0) { let j = G - 1; while (dig[j] === 2) { apply(j, 2, -1); apply(j, 0, 1); dig[j] = 0; ties++; j--; } apply(j, dig[j], -1); if (dig[j] === 0) ties--; dig[j]++; apply(j, dig[j], 1); }
    let info;
    if (rules.divCount < 2) {
      const w = st.wp[ti]; let above = 0; members.length = 0;
      for (let q = 0; q < n; q++) { const v = st.wp[q]; if (v > w) above++; else if (v === w) members.push(q); }
      if (members.length === 1) info = { start: above, size: 1, counts: null, total: 1 };
      else {
        let key = members.join(",") + "|";
        for (let p = 0; p < members.length; p++) for (let q = p + 1; q < members.length; q++) key += st.h2h[members[p] * n + members[q]] + ".";
        key += "|"; for (const m of members) key += st.divPts[m] + ".";
        let res = memo.get(key);
        if (!res) {
          const G0 = members.slice();
          const perms = G0.length > ENUM_CAP ? [G0] : permutations(G0);
          const outs = perms.map((perm) => { const rank = Int32Array.from(rankBase); perm.forEach((t, r) => { rank[t] = -n + r; }); return resolveTied(G0, rules, st, rank); });
          res = blocksFrom(outs[0], outs, 0).team;
          if (memo.size > 200000) memo.clear(); memo.set(key, res);
        }
        const r = res.get(ti); info = { start: above + r.start, size: r.size, counts: r.counts, total: r.total };
      }
    } else {
      // Divisions: only the team's own unit (teams level on its win points) matters,
      // memoised on its members, which of them can win a division, their results
      // against one another and their division points; offsets place it.
      const dc = divisionContext(rules, st), v = st.wp[ti], off = unitOffsets(rules, st, v, dc);
      members.length = 0; for (let q = 0; q < n; q++) if (st.wp[q] === v) members.push(q);
      let key = members.join(",") + "|";
      for (const m of members) key += (dc.divMax.get(rules.div[m]) === v ? 1 : 0);
      key += "|"; for (let p = 0; p < members.length; p++) for (let q = p + 1; q < members.length; q++) key += st.h2h[members[p] * n + members[q]] + ".";
      key += "|"; for (const m of members) key += st.divPts[m] + ".";
      let res = memo.get(key);
      if (!res) {
        const perms = members.length === 1 || members.length > ENUM_CAP ? [null] : permutations(members.slice());
        const tally = new Map(); // outcome for the team: "w<k>" or "r<k>" -> count
        for (const p of perms) {
          let rank = rankBase; if (p) { rank = Int32Array.from(rankBase); p.forEach((t, r) => { rank[t] = -n + r; }); }
          const oc = unitOutcome(rules, st, members, v, dc, rank);
          const k = oc.win.includes(ti) ? "w" + oc.win.indexOf(ti) : "r" + oc.rest.indexOf(ti);
          tally.set(k, (tally.get(k) || 0) + 1);
        }
        res = { tally, total: perms.length };
        if (memo.size > 200000) memo.clear(); memo.set(key, res);
      }
      const places = []; res.tally.forEach((c, k) => { places.push([k[0] === "w" ? off.winAbove + Number(k.slice(1)) : dc.D + off.restAbove + Number(k.slice(1)), c]); });
      let lo = Infinity, hi = -Infinity; for (const [q] of places) { lo = Math.min(lo, q); hi = Math.max(hi, q); }
      let counts = null; if (hi > lo) { counts = new Array(hi - lo + 1).fill(0); for (const [q, c] of places) counts[q - lo] += c; }
      info = { start: lo, size: hi - lo + 1, counts, total: res.total };
    }
    const id = leafId(info.start, info.size, info.counts, info.total); leaf[x] = id;
    for (let i = 0; i < info.size; i++) fin[info.start + i] += info.counts ? info.counts[i] / info.total : 1 / info.size;
    for (let q = 0; q < trims.length; q++) {
      const tr = trims[q]; if (X < tr.lo || X >= tr.hi) continue;
      tr.n++; for (let i2 = 0; i2 < info.size; i2++) if (info.start + i2 < input.places) tr.pl += info.counts ? info.counts[i2] / info.total : 1 / info.size;
      const b = tr.best, above = info.start, level = info.size;
      if (b && (above > b.s || (above === b.s && level > b.k))) continue;
      let lead = NO_LEAD;
      if (level > 1) { let m = -Infinity; for (let q = 0; q < n; q++) if (q !== ti && st.wp[q] === st.wp[ti] && tr.pf[q] > m) m = tr.pf[q]; lead = tr.pf[ti] - m; }
      if (!b || above < b.s || level < b.k || lead > b.lead || (lead === b.lead && ties < b.ties)) tr.best = { s: above, k: level, lead, ties, x: X };
    }
  }
  if (table.length > 1500) throw new Error(`too many kinds of finish for one team (${table.length})`);
  const LB = table.length <= 256 ? 256 : 65536;
  const { nodes, root } = opts.scanOnly ? { nodes: new Int32Array(0), root: 0 } : reduceLeaves(leaf, G, LB, k);
  return { nodes, root, LB, leaves: table, fin: Array.from(fin), best: trims.map((t) => t.best), trimOdds: trims.map((t) => [t.pl, t.n]), paths: NP };
}

/**
 * Merges parts into one part covering them all, folding each part in and letting it go,
 * so memory holds the growing table and one part at a time. Parts rooted at level
 * kFrom merge into one rooted at kTo; merging to 0 gives the team's whole map. The
 * table is keyed on (game, children) with open addressing, so the result is the same
 * canonical map a single pass builds. Finish counts add up; the best default-path
 * candidate wins, earlier paths winning ties exactly as a single pass would.
 */
export function makeMerger(metas, kFrom, kTo, nTeams, nTrims) {
  let leaves = null; const leafIds = new Map();
  for (const m of metas) if (m.leaves) leaves = leaves || [];
  const remap = metas.map((m) => (m.leaves ? m.leaves.map((L) => {
    const key = L.counts ? `${L.start},${L.size},${L.counts.join(".")}/${L.total}` : `${L.start},${L.size}`;
    let id = leafIds.get(key); if (id === undefined) { id = leaves.length; leafIds.set(key, id); leaves.push(L); } return id; }) : null));
  const LB = leaves ? (leaves.length <= 256 ? 256 : 65536) : 256;
  let buf = new Int32Array(1 << 16), cap = 1 << 16, slots = new Int32Array(cap).fill(-1), used = 0;
  const hash = (j, a, b, c) => { let h = Math.imul(j + 0x9e3779b9, 0x85ebca6b); h = Math.imul(h ^ a, 0xc2b2ae35); h = Math.imul(h ^ b, 0x27d4eb2f); h = Math.imul(h ^ c, 0x165667b1); return (h ^ (h >>> 15)) >>> 0; };
  const rehash = () => { cap *= 2; slots = new Int32Array(cap).fill(-1); for (let q = 0; q < used; q++) { let i = hash(buf[4 * q], buf[4 * q + 1], buf[4 * q + 2], buf[4 * q + 3]) & (cap - 1); while (slots[i] !== -1) i = (i + 1) & (cap - 1); slots[i] = q; } };
  const mk = (j, a, b, c) => {
    if (a === b && b === c) return a;
    let i = hash(j, a, b, c) & (cap - 1);
    while (slots[i] !== -1) { const q = slots[i]; if (buf[4 * q] === j && buf[4 * q + 1] === a && buf[4 * q + 2] === b && buf[4 * q + 3] === c) return LB + q; i = (i + 1) & (cap - 1); }
    const q = used++; if (4 * used > buf.length) { const nb = new Int32Array(buf.length * 2); nb.set(buf); buf = nb; }
    buf[4 * q] = j; buf[4 * q + 1] = a; buf[4 * q + 2] = b; buf[4 * q + 3] = c; slots[i] = q;
    if (used * 2 > cap) rehash();
    return LB + q;
  };
  const roots = new Array(metas.length);
  return {
    /** Folds part c in; the part can be let go afterwards. */
    add(c, p) {
      const loc = new Int32Array(p.nodes.length / 4), g = (x) => (x < p.LB ? (remap[c] ? remap[c][x] : x) : loc[x - p.LB]);
      for (let q = 0; q < loc.length; q++) loc[q] = mk(p.nodes[4 * q], g(p.nodes[4 * q + 1]), g(p.nodes[4 * q + 2]), g(p.nodes[4 * q + 3]));
      roots[c] = g(p.root);
    },
    finish() {
      let top = roots;
      for (let j = kFrom - 1; j >= kTo; j--) { const out = []; for (let q = 0; q < top.length / 3; q++) out.push(mk(j, top[3 * q], top[3 * q + 1], top[3 * q + 2])); top = out; }
      const fin = new Array(nTeams).fill(0); for (const m of metas) m.fin.forEach((v, i) => { fin[i] += v; });
      const better = (a, b) => !b || a.s < b.s || (a.s === b.s && (a.k < b.k || (a.k === b.k && (a.lead > b.lead || (a.lead === b.lead && a.ties < b.ties)))));
      const best = Array.from({ length: nTrims }, (_, q) => { let bb = null; for (const m of metas) { const c = m.best[q]; if (c && better(c, bb)) bb = c; } return bb; });
      const trimOdds = Array.from({ length: nTrims }, (_, q) => metas.reduce((a, m) => (m.trimOdds && m.trimOdds[q] ? [a[0] + m.trimOdds[q][0], a[1] + m.trimOdds[q][1]] : a), [0, 0]));
      return { nodes: buf.slice(0, 4 * used), root: top[0], LB, leaves, fin, best, trimOdds, paths: metas.reduce((a, m) => a + m.paths, 0) };
    },
  };
}

/** The same merge, loading parts one at a time (the build object reads them from R2). */
export async function mergeParts(count, loadPart, kFrom, kTo, nTeams, nTrims) {
  const metas = []; for (let c = 0; c < count; c++) metas.push(await loadPart(c, false));
  const m = makeMerger(metas, kFrom, kTo, nTeams, nTrims);
  for (let c = 0; c < count; c++) m.add(c, await loadPart(c, true));
  return m.finish();
}

/** A team's whole map from one merged part: odds, default paths and simplest paths. */
export function finishFromPart(input, ti, part) {
  const G = input.games.length, N = RESULTS_PER_GAME ** G;
  const digitsOf = (x) => { const d = new Array(G); for (let j = G - 1; j >= 0; j--) { d[j] = x % 3; x = Math.floor(x / 3); } return d.join(""); };
  const odds = part.fin.slice(0, input.places).reduce((a, v) => a + v, 0) / N;
  const map = { nodes: part.nodes, root: part.root, G, leafBase: part.LB, leaves: part.leaves };
  const ix = new Map(input.teams.map((t, i) => [t.id, i])), own = (g) => ix.get(g.a) === ti || ix.get(g.b) === ti;
  const simple = (input.trims || []).map((tr) => {
    const pins = new Int8Array(G).fill(-1); for (let j = 0; j < tr.fixed; j++) pins[j] = input.future[j].digit;
    const order = input.games.map((g, j) => j).filter((j) => j >= tr.fixed).sort((x, y) => (own(input.games[y]) - own(input.games[x])) || x - y);
    const prefer = (j) => { const g = input.games[j]; return ix.get(g.a) === ti ? 1 : ix.get(g.b) === ti ? 2 : ((g.pA ?? 0.5) >= (g.pB ?? 0.5) ? 1 : 2); };
    const r = simplestPath(map, pins, input.places, { order, prefer, budgetMs: Infinity, maxWork: 25e6, now: () => 0 });   // ~25M node visits: a few seconds at most
    return r.set ? { k: r.k, set: r.set } : { k: r.k, set: null, timedOut: !!r.timedOut };
  });
  return {
    nodes: part.nodes, root: part.root, nodeCount: part.nodes.length / 4, odds, ...(part.leaves ? { leafBase: part.LB, leaves: part.leaves } : {}),
    trims: part.best.map((b, q) => (b ? { defaultPath: digitsOf(b.x), best: { start: b.s, size: b.k, lead: b.lead >= NO_LEAD ? null : +b.lead.toFixed(2) }, simplest: simple[q],
      odds: part.trimOdds && part.trimOdds[q] && part.trimOdds[q][1] ? +(part.trimOdds[q][0] / part.trimOdds[q][1]).toFixed(6) : null } : null)),
  };
}

/** Merges a team's parts (all in memory) straight to its map. */
export function finishTeam(input, ti, parts, k) {
  const m = makeMerger(parts, k, 0, input.teams.length, (input.trims || []).length);
  parts.forEach((p, c) => m.add(c, p));
  return finishFromPart(input, ti, m.finish());
}

/**
 * When a build fits, judged on the simulation alone (the page accepts a map of any size).
 * From measurements on Cloudflare (dev portal benchmarks, September 2026): a path costs
 * about 130 ns to build under a points-based rule, 1.9 µs under head-to-head and 4.5 µs
 * with divisions, with merges and gaps adding about a third. The daily budget is the
 * Durable Object duration quota (13,000 GB-s at 128 MB, so 104,000 s a day) times the
 * governor's allowance. A team's map grows as paths^0.41 from about 135,000 nodes at
 * 14.3 million paths (measured: 454,000 to 1.32 million nodes at 3.49 billion paths), and
 * a merge must hold it: about 40 bytes a node against 128 MB.
 */
export function feasibility({ teams, weeksLeft, kind = "fast", allowancePct = 50, maxDays = 3 }) {
  const games = (teams / 2) * weeksLeft, paths = RESULTS_PER_GAME ** games;
  const ns = { fast: 130, h2h: 1900, div: 4500 }[kind] || 130;
  const cpuS = (paths * teams * ns) / 1e9 * 1.35;
  const perDayS = 104000 * (allowancePct / 100), days = cpuS / perDayS;
  const nodes = Math.round(135000 * Math.pow(paths / 14348907, 0.41)), mergeMB = Math.round((nodes * 40) / 1e6);
  const why = mergeMB > 100 ? "merge memory" : days > maxDays ? "time" : paths > PATH_CEILING ? "ceiling" : null;
  return { teams, weeksLeft, games, paths, hours: +(cpuS / 3600).toFixed(2), days: +days.toFixed(2), nodes, mergeMB, ok: !why, why };
}

/** How many parts a team needs: 3^k, so each part stays under the slice target and the part ceiling. */
export function partPlan(input, { nsPerPath = { fast: 130, h2h: 1900, div: 4500 }, targetMs = 10000 } = {}) {
  const rules = makeRules(input), G = input.games.length, N = RESULTS_PER_GAME ** G;
  const ns = rules.fast ? nsPerPath.fast : rules.divCount >= 2 ? nsPerPath.div : nsPerPath.h2h;
  let k = 0; while (k < G && ((N / 3 ** k) * ns / 1e6 > targetMs || N / 3 ** k > PART_CEILING)) k++;
  return { k, parts: 3 ** k, perPartMs: Math.round((N / 3 ** k) * ns / 1e6), kind: rules.fast ? "fast" : rules.divCount >= 2 ? "div" : "h2h", ns };
}

/** The summary the page reads, from the input and every team's slice. */
export function assembleSummary(input, results, extra = {}) {
  return {
    schema: 3, leagueName: input.leagueName, season: input.season, places: input.places, consolation: input.consolation,
    tieRule: input.tieRule, resultsPerGame: RESULTS_PER_GAME, windowStart: input.windowStart, fingerprint: input.fingerprint || null, engineVersion: input.engineVersion || null,
    realWeeks: input.realWeeks || [], seed: input.seed ?? null,
    teams: input.teams.map((t) => ({ id: t.id, name: t.name, w: t.w, l: t.l, t: t.t, pf: t.pf, pa: t.pa })),
    paths: pathCount(input), games: input.games, future: input.future,
    trims: input.trims.map((tr, k) => ({ thru: tr.thru, fixed: tr.fixed, pf: tr.pf,
      defaultPath: results.map((r) => r.trims[k].defaultPath), best: results.map((r) => r.trims[k].best), simplest: results.map((r) => r.trims[k].simplest || null),
      odds: results.map((r) => (r.trims[k] && r.trims[k].odds != null ? r.trims[k].odds : null)) })),
    seedingRule: input.seedingRule, divisions: input.divisions || null, played: input.played || [],
    maps: input.teams.map((t, i) => ({ teamId: t.id, root: results[i].root, nodes: results[i].nodeCount, ...(results[i].leaves ? { leafBase: results[i].leafBase, leaves: results[i].leaves } : {}) })),
    ...extra,
  };
}

/** Raw deflate, as the page's DecompressionStream("deflate-raw") expects. */
export async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
