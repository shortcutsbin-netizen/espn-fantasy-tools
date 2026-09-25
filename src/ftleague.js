/**
 * Fortune Teller's view of the real league, from the stored ESPN datasets: which weeks
 * are settled, the input a build needs, and the fingerprint that says when a built tree
 * no longer matches the league. Plain module, tested against captured ESPN responses.
 *
 * Win chances: for the week ESPN is currently scoring, ESPN's own matchup win
 * probability. For later weeks, each team's ESPN-projected total from its best eligible
 * lineup (every player's single-week projection for that scoring period), turned into a
 * chance by a normal model of the score difference. "ESPN projected wins" is therefore
 * the team ESPN projects to score more.
 */
import { feasibility, PATH_CEILING } from './ftbuild.js';

export const ENGINE_VERSION = 3;
export const SCORE_DIFF_SD = 25;      // spread of one matchup's score difference, in points
export const TIE_CHANCE = 0.004;      // a tie on points to two decimals is rare but possible
const LEAGUE_HOST = 'https://lm-api-reads.fantasy.espn.com';

export const leagueUrl = (cfg, query) => `${LEAGUE_HOST}/apis/v3/games/ffl/seasons/${cfg.season}/segments/0/leagues/${cfg.leagueId}${query}`;
const settingsOf = (raw) => (raw && raw.settings ? raw.settings : raw) || {};
const result = (w) => (w === 'HOME' ? 1 : w === 'AWAY' ? 2 : w === 'TIE' ? 0 : null);

/** Weeks, what is settled, and the league's size and rules. */
export function leagueState(sched, settingsRaw) {
  const s = settingsOf(settingsRaw), sch = s.scheduleSettings || {}, mpc = sch.matchupPeriodCount || 13;
  const games = (sched && sched.schedule ? sched.schedule : []).filter((m) => m.matchupPeriodId <= mpc && m.home && m.away);
  const byWeek = new Map(); for (const g of games) { if (!byWeek.has(g.matchupPeriodId)) byWeek.set(g.matchupPeriodId, []); byWeek.get(g.matchupPeriodId).push(g); }
  let lastSettled = 0;
  for (let w = 1; w <= mpc; w++) { const wg = byWeek.get(w) || []; if (wg.length && wg.every((g) => result(g.winner) != null)) lastSettled = w; else break; }
  const teamCount = new Set(games.flatMap((g) => [g.home.teamId, g.away.teamId])).size;
  const divisions = (sch.divisions || []).length;
  const rule = sch.playoffSeedingRule || 'TOTAL_POINTS_SCORED';
  const kind = divisions >= 2 ? 'div' : ['TOTAL_POINTS_SCORED', 'TOTAL_POINTS_AGAINST'].includes(rule) ? 'fast' : 'h2h';
  return { mpc, lastSettled, current: (sched && sched.status && sched.status.currentMatchupPeriod) || lastSettled + 1,
    weeksLeft: mpc - lastSettled, seasonOver: lastSettled >= mpc, teamCount, gamesPerWeek: teamCount / 2, rule, divisions, kind, byWeek };
}

/** When a build fits: now, or after which week it will. */
export function readiness(state, allowancePct = 50) {
  if (state.seasonOver) return { now: false, opensAfterWeek: null };
  const fits = (w) => feasibility({ teams: state.teamCount, weeksLeft: w, kind: state.kind, allowancePct });
  const now = fits(state.weeksLeft);
  let opensAfterWeek = null;
  for (let w = state.weeksLeft; w >= 1; w--) if (fits(w).ok) { opensAfterWeek = state.mpc - w; break; }
  return { now: now.ok, estimate: now, opensAfterWeek };
}

/** One team's projected total for a week: its best eligible lineup by ESPN projection. */
export function lineupTotal(entries, slotCounts) {
  const slots = [];
  for (const [id, n] of Object.entries(slotCounts || {})) { const sid = Number(id); if (sid === 20 || sid === 21 || !n) continue; for (let k = 0; k < n; k++) slots.push(sid); }
  const cand = entries.filter((e) => e.proj != null && e.proj > 0);
  const pool = (sid) => cand.filter((e) => (e.eligibleSlots || []).includes(sid)).length;
  slots.sort((a, b) => pool(a) - pool(b));            // most specific slots first, flex last
  const used = new Set(); let total = 0;
  for (const sid of slots) {
    let best = null;
    for (const e of cand) if (!used.has(e.id) && (e.eligibleSlots || []).includes(sid) && (!best || e.proj > best.proj)) best = e;
    if (best) { used.add(best.id); total += best.proj; }
  }
  return Math.round(total * 100) / 100;
}

/** A raw ESPN roster response for one scoring period, reduced to each team's projected total. */
export function projectedTotals(rawRoster, week, slotCounts) {
  const out = new Map();
  for (const t of (rawRoster && rawRoster.teams) || []) {
    const entries = ((t.roster && t.roster.entries) || t.entries || []).map((e) => {
      if (e.playerPoolEntry) {
        const p = e.playerPoolEntry.player || {};
        const st = (p.stats || []).find((x) => x.statSourceId === 1 && x.statSplitTypeId === 1 && x.scoringPeriodId === week);
        return { id: p.id, eligibleSlots: p.eligibleSlots || [], proj: st ? st.appliedTotal : null };
      }
      return e;
    });
    out.set(t.id, lineupTotal(entries, slotCounts));
  }
  return out;
}

const phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };

/** FNV-1a over a canonical string: small, stable, good enough to notice any change. */
function hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); }

/**
 * Everything the tree depends on: results before the window, the window's fixtures, the
 * rules, and the engine. Results inside the window are not part of it: those move the
 * week forward (an update), they never rebuild.
 */
export function treeFingerprint(sched, settingsRaw, teamsRaw, windowStart, season) {
  const s = settingsOf(settingsRaw), sch = s.scheduleSettings || {}, mpc = sch.matchupPeriodCount || 13;
  const games = (sched.schedule || []).filter((m) => m.matchupPeriodId <= mpc && m.home && m.away).sort((a, b) => a.matchupPeriodId - b.matchupPeriodId || a.id - b.id);
  const before = games.filter((g) => g.matchupPeriodId < windowStart).map((g) => [g.matchupPeriodId, g.home.teamId, g.away.teamId, result(g.winner), g.home.totalPoints, g.away.totalPoints]);
  const window = games.filter((g) => g.matchupPeriodId >= windowStart).map((g) => [g.matchupPeriodId, g.id, g.home.teamId, g.away.teamId]);
  const divs = ((teamsRaw && teamsRaw.teams) || []).map((t) => [t.id, t.divisionId]).sort((a, b) => a[0] - b[0]);
  return hash(JSON.stringify({ v: ENGINE_VERSION, season, windowStart, before, window, places: sch.playoffTeamCount, rule: sch.playoffSeedingRule, divs,
    tie: s.scoringSettings && s.scoringSettings.matchupTieRule, consolation: !sch.consolationLadderDisabled }));
}

/** Win chances and projections for window games. `projections` maps week -> teamId -> total. */
export function gameChances(g, week, current, projections, ppg) {
  const pT = TIE_CHANCE;
  if (week === current && g.home.winProbability != null && g.away.winProbability != null) {
    const a = g.home.winProbability, b = g.away.winProbability, sum = a + b || 1;
    return { pA: +(a / sum * (1 - pT)).toFixed(3), pB: +(b / sum * (1 - pT)).toFixed(3), pT,
      projA: +(g.home.totalProjectedPoints ?? 0).toFixed(1), projB: +(g.away.totalProjectedPoints ?? 0).toFixed(1), source: 'espn' };
  }
  const pw = projections && projections.get(week);
  let pa = pw && pw.get(g.home.teamId), pb = pw && pw.get(g.away.teamId), source = 'projection';
  if (!(pa > 0) || !(pb > 0)) { pa = ppg.get(g.home.teamId) || 100; pb = ppg.get(g.away.teamId) || 100; source = 'season average'; }
  const pA = phi((pa - pb) / SCORE_DIFF_SD) * (1 - pT);
  return { pA: +pA.toFixed(3), pB: +(1 - pT - pA).toFixed(3), pT, projA: +pa.toFixed(1), projB: +pb.toFixed(1), source };
}

/** The input a build needs, from the real league, with the window starting at `windowStart`. */
export function buildRealInput({ sched, settingsRaw, teamsRaw, names, projections, season }, windowStart) {
  const s = settingsOf(settingsRaw), sch = s.scheduleSettings || {}, mpc = sch.matchupPeriodCount || 13;
  const st = leagueState(sched, settingsRaw);
  const games = (sched.schedule || []).filter((m) => m.matchupPeriodId <= mpc && m.home && m.away).sort((a, b) => a.matchupPeriodId - b.matchupPeriodId || a.id - b.id);
  const ids = [...new Set(games.flatMap((g) => [g.home.teamId, g.away.teamId]))].sort((a, b) => a - b);
  const rec = new Map(ids.map((id) => [id, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }])), played = [];
  for (const g of games) {
    if (g.matchupPeriodId >= windowStart) continue;
    const r = result(g.winner); if (r == null) continue;
    const h = rec.get(g.home.teamId), a = rec.get(g.away.teamId), hp = g.home.totalPoints || 0, ap = g.away.totalPoints || 0;
    h.pf += hp; h.pa += ap; a.pf += ap; a.pa += hp;
    if (r === 1) { h.w++; a.l++; } else if (r === 2) { a.w++; h.l++; } else { h.t++; a.t++; }
    played.push({ a: g.home.teamId, b: g.away.teamId, res: r });
  }
  const weeksPlayed = Math.max(1, windowStart - 1), ppg = new Map(ids.map((id) => [id, rec.get(id).pf / weeksPlayed]));
  const teams = ids.map((id) => { const r = rec.get(id); return { id, name: (names && names.get(id)) || `Team ${id}`, w: r.w, l: r.l, t: r.t, pf: +r.pf.toFixed(2), pa: +r.pa.toFixed(2) }; });
  const win = games.filter((g) => g.matchupPeriodId >= windowStart);
  const gOut = win.map((g, i) => ({ i, week: g.matchupPeriodId, matchupId: g.id, a: g.home.teamId, b: g.away.teamId, ...gameChances(g, g.matchupPeriodId, st.current, projections, ppg) }));
  const future = win.map((g, i) => ({ i, week: g.matchupPeriodId, digit: null, hp: null, ap: null }));
  const divisions = (() => { const m = ((teamsRaw && teamsRaw.teams) || []).filter((t) => t.divisionId != null); return new Set(m.map((t) => t.divisionId)).size > 1 ? Object.fromEntries(m.map((t) => [t.id, String(t.divisionId)])) : null; })();
  return {
    leagueName: s.name || 'League', season, places: sch.playoffTeamCount || 4, consolation: !sch.consolationLadderDisabled,
    seedingRule: sch.playoffSeedingRule || 'TOTAL_POINTS_SCORED', tieRule: (s.scoringSettings && s.scoringSettings.matchupTieRule) || null,
    windowStart, realWeeks: Array.from({ length: windowStart - 1 }, (_, k) => k + 1), teams, games: gOut, future, played, divisions,
    trims: [{ thru: windowStart - 1, fixed: 0, pf: teams.map((t) => t.pf) }],
    fingerprint: treeFingerprint(sched, settingsRaw, teamsRaw, windowStart, season), engineVersion: ENGINE_VERSION,
  };
}

/** The results of window weeks settled since the tree was last moved on: the next trims. */
export function newTrims(summary, sched) {
  const byId = new Map((sched.schedule || []).map((m) => [m.id, m]));
  const last = summary.trims[summary.trims.length - 1], out = [];
  const weeks = [...new Set(summary.games.map((g) => g.week))].sort((a, b) => a - b);
  const future = summary.future.map((f) => ({ ...f }));
  let pf = last.pf.slice(); const ix = new Map(summary.teams.map((t, i) => [t.id, i]));
  for (const w of weeks) {
    if (w <= last.thru) continue;
    const wg = summary.games.filter((g) => g.week === w), results = wg.map((g) => byId.get(g.matchupId));
    if (!results.every((m) => m && result(m.winner) != null)) break;
    wg.forEach((g, k) => { const m = results[k]; future[g.i] = { i: g.i, week: w, digit: result(m.winner), hp: m.home.totalPoints, ap: m.away.totalPoints };
      pf[ix.get(g.a)] += m.home.totalPoints || 0; pf[ix.get(g.b)] += m.away.totalPoints || 0; });
    pf = pf.map((v) => +v.toFixed(2));
    out.push({ thru: w, fixed: summary.games.filter((g) => g.week <= w).length, pf: pf.slice() });
  }
  return { trims: out, future };
}

export { PATH_CEILING };
