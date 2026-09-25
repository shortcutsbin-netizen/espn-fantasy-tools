/**
 * LLM Data Export — the league-wide document.
 *
 * One digest, built at refresh time from the stored free-agent pool and the
 * digests and small payloads listed in its derivation's `needs`. The reader's
 * team and the compact form are applied in the browser (app/llm-export/), so
 * this is shared by every member and never carries a per-reader choice.
 *
 * Deliberately absent, for every team: owner names and account ids, pending
 * waiver claims, logos inside the export, and anything from the ESPN session.
 */
import { teamLogoUrl } from './derive.js';
import { FREE_AGENT_DEPTH } from './datasets.js';

export { FREE_AGENT_DEPTH };

export const SCHEMA_VERSION = 1;


const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const SLOT = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'Bench', 21: 'IR', 23: 'FLEX' };
const SLOT_ORDER = [0, 2, 4, 6, 23, 16, 17, 20, 21];
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'D/ST', 'K'];
const PRO = { 0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE',
  18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA',
  27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU' };
const INJURY = { QUESTIONABLE: 'questionable', DOUBTFUL: 'doubtful', OUT: 'out',
  INJURY_RESERVE: 'injured reserve', SUSPENSION: 'suspended', DAY_TO_DAY: 'day-to-day',
  PROBABLE: 'probable' };
const ACQ = { DRAFT: 'draft', ADD: 'pickup', TRADE: 'trade' };
/* The site's own words for a trade's outcome: withdrawn, rejected and expired
   are three different things. */
const TRADE_STATUS = { completed: 'completed', pending_approval: 'pending approval',
  on_the_table: 'on the table', cancelled: 'withdrawn', rejected: 'rejected', expired: 'expired' };
const TX_KIND = { waiver: 'waiver claim', add: 'free-agent add', swap: 'free-agent add/drop', drop: 'drop' };
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

/* ESPN scoring stat ids, in words. An id missing here is written as
   "stat <id>" rather than guessed at. 198 and 209 are absent from the public
   stat maps; their labels are inferred from the point values leagues give them. */
const STAT = {
  3: ['offense', 'Passing yards', 'yard'], 4: ['offense', 'Passing touchdown'],
  19: ['offense', 'Two-point conversion (pass)'], 20: ['offense', 'Interception thrown'],
  24: ['offense', 'Rushing yards', 'yard'], 25: ['offense', 'Rushing touchdown'],
  26: ['offense', 'Two-point conversion (rush)'],
  42: ['offense', 'Receiving yards', 'yard'], 43: ['offense', 'Receiving touchdown'],
  44: ['offense', 'Two-point conversion (reception)'], 53: ['offense', 'Reception'],
  63: ['offense', 'Fumble recovered for a touchdown'], 72: ['offense', 'Fumble lost'],
  74: ['kicking', 'Field goal made, 50+ yards'], 77: ['kicking', 'Field goal made, 40-49 yards'],
  80: ['kicking', 'Field goal made, under 40 yards'], 85: ['kicking', 'Field goal missed'],
  86: ['kicking', 'Extra point made'], 88: ['kicking', 'Extra point missed'],
  198: ['kicking', 'Field goal made, 50-59 yards'], 201: ['kicking', 'Field goal made, 60+ yards'],
  89: ['defense', '0 points allowed'], 90: ['defense', '1-6 points allowed'],
  91: ['defense', '7-13 points allowed'], 92: ['defense', '14-17 points allowed'],
  120: ['defense', '18-21 points allowed'], 121: ['defense', '22-27 points allowed'],
  123: ['defense', '28-34 points allowed'], 124: ['defense', '35-45 points allowed'],
  125: ['defense', '46+ points allowed'],
  128: ['defense', 'Under 100 yards allowed'], 129: ['defense', '100-199 yards allowed'],
  130: ['defense', '200-299 yards allowed'], 131: ['defense', '300-349 yards allowed'],
  132: ['defense', '350-399 yards allowed'], 133: ['defense', '400-449 yards allowed'],
  134: ['defense', '450-499 yards allowed'], 135: ['defense', '500-549 yards allowed'],
  136: ['defense', '550+ yards allowed'],
  93: ['defense', 'Blocked kick returned for a touchdown'], 95: ['defense', 'Interception'],
  96: ['defense', 'Fumble recovered'], 97: ['defense', 'Blocked kick'], 98: ['defense', 'Safety'],
  99: ['defense', 'Sack'], 206: ['defense', 'Two-point return'], 209: ['defense', 'One-point safety'],
  101: ['returns', 'Kickoff return touchdown'], 102: ['returns', 'Punt return touchdown'],
  103: ['returns', 'Interception return touchdown'], 104: ['returns', 'Fumble return touchdown'],
};

const r1 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 10) / 10 : null);
const iso = (ms) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
const clean = (o) => {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k];
  return o;
};
const idx = (list, v) => { const i = list.indexOf(v); return i < 0 ? 99 : i; };
const record = (w, l, t) => `${w}-${l}${t ? `-${t}` : ''}`;
const tieRule = (r) => (!r || r === 'NONE' ? 'ties stand' : r.toLowerCase().replace(/_/g, ' '));

function leagueSection(settingsDoc, teamCount) {
  const s = settingsDoc.settings || {};
  const roster = s.rosterSettings || {};
  const counts = roster.lineupSlotCounts || {};
  const lineup = {};
  for (const id of SLOT_ORDER) {
    if (counts[id]) lineup[id === 23 ? 'FLEX (RB/WR/TE)' : SLOT[id]] = counts[id];
  }
  const starters = [0, 2, 4, 6, 23, 16, 17].reduce((n, id) => n + (counts[id] || 0), 0);
  const maxes = {};
  for (const [id, n] of Object.entries(roster.positionLimits || {})) {
    if (POS[id]) maxes[POS[id]] = n < 0 ? 'no limit' : n;
  }

  const scoringSettings = s.scoringSettings || {};
  const scoring = { offense: [], kicking: [], defenseAndSpecialTeams: [], returnTouchdowns: [] };
  for (const it of scoringSettings.scoringItems || []) {
    const meta = STAT[it.statId] || ['offense', `stat ${it.statId}`];
    const dst = it.pointsOverrides && it.pointsOverrides['16'];
    const row = { stat: meta[1] };
    if (it.points === 0 && dst != null) { row.points = dst; row.appliesTo = 'D/ST only'; } else {
      row.points = it.points;
      if (dst != null && dst !== it.points) row.dstPoints = dst;
    }
    if (meta[2]) row.per = meta[2];
    const group = meta[0] === 'defense' || row.appliesTo ? 'defenseAndSpecialTeams'
      : meta[0] === 'returns' ? 'returnTouchdowns' : meta[0];
    scoring[group].push(row);
  }
  for (const g of Object.keys(scoring)) scoring[g].sort((a, b) => a.stat.localeCompare(b.stat));

  const sch = s.scheduleSettings || {};
  const periods = sch.matchupPeriods || {};
  const regular = sch.matchupPeriodCount || 0;
  const post = Object.keys(periods).map(Number).filter((k) => k > regular).sort((a, b) => a - b);
  const names = post.length === 1 ? ['Final'] : post.length === 2 ? ['Semifinals', 'Final']
    : post.length === 3 ? ['Quarterfinals', 'Semifinals', 'Final'] : post.map((_, i) => `Round ${i + 1}`);
  const acq = s.acquisitionSettings || {};
  const trade = s.tradeSettings || {};
  const draft = s.draftSettings || {};
  const seedRule = sch.playoffSeedingRule || '';

  return {
    name: s.name || '',
    teams: teamCount,
    format: `Head-to-head points, ${scoringSettings.playerRankType === 'PPR' ? 'full PPR'
      : scoringSettings.playerRankType === 'PPR_HALF' ? 'half PPR'
        : scoringSettings.playerRankType === 'STANDARD' ? 'standard scoring'
          : String(scoringSettings.playerRankType || 'custom scoring')}`,
    lineup,
    startersPerWeek: starters,
    rosterSize: starters + (counts[20] || 0),
    irSlots: counts[21] || 0,
    positionMaximums: maxes,
    lineupLock: roster.lineupLocktimeType === 'INDIVIDUAL_GAME'
      ? "Each player locks at his own game's kickoff"
      : 'The whole lineup locks at the first kickoff of the week',
    scoring,
    season: {
      regularSeasonWeeks: `1-${regular}`,
      postseasonTeams: sch.playoffTeamCount || 0,
      seeding: `Best record; ties broken by ${seedRule === 'TOTAL_POINTS_SCORED'
        ? 'total points scored' : (seedRule.toLowerCase().replace(/_/g, ' ') || 'league rules')}`,
      postseasonRounds: post.map((k, i) => ({ round: names[i], weeks: periods[k] })),
      consolationBracket: !sch.consolationLadderDisabled,
      regularSeasonTies: tieRule(scoringSettings.matchupTieRule),
      postseasonTies: tieRule(scoringSettings.playoffMatchupTieRule),
    },
    waivers: {
      system: acq.isUsingAcquisitionBudget
        ? `FAAB: $${acq.acquisitionBudget} budget, $${acq.minimumBid} minimum bid`
        : 'Waiver priority order (no FAAB budget)',
      order: acq.waiverOrderReset ? 'Resets each week' : 'Rolling',
      hoursOnWaivers: acq.waiverHours,
      processDays: DAYS.filter((d) => (acq.waiverProcessDays || []).includes(d))
        .map((d) => d[0] + d.slice(1, 3).toLowerCase()),
      acquisitionLimit: acq.acquisitionLimit == null || acq.acquisitionLimit < 0 ? 'none' : acq.acquisitionLimit,
    },
    trades: {
      deadline: iso(trade.deadlineDate),
      reviewPeriodHours: trade.revisionHours,
      vetoVotesToReject: trade.vetoVotesRequired,
      limit: trade.max == null || trade.max < 0 ? 'none' : trade.max,
    },
    draft: { type: draft.type === 'SNAKE' ? 'Snake' : draft.type === 'AUCTION' ? 'Auction' : draft.type, date: iso(draft.date) },
  };
}

function splits(stats, season, period) {
  const out = { weekly: {} };
  for (const s of stats || []) {
    const src = s.statSourceId; const split = s.statSplitTypeId;
    if (s.seasonId === season && src === 0 && split === 1 && s.scoringPeriodId > 0) {
      out.weekly[s.scoringPeriodId] = r1(s.appliedTotal);
    } else if (s.seasonId === season && src === 0 && split === 0) {
      out.seasonPts = r1(s.appliedTotal); out.seasonAvg = r1(s.appliedAverage);
    } else if (s.seasonId === season - 1 && src === 0 && split === 0) {
      out.lastSeasonPts = r1(s.appliedTotal);
    } else if (s.seasonId === season && src === 1 && split === 1 && s.scoringPeriodId === period) {
      if (out.weekProj == null) out.weekProj = r1(s.appliedTotal);
    } else if (s.seasonId === season && src === 1 && split === 2) {
      if (out.rosProj == null) out.rosProj = r1(s.appliedTotal);
    } else if (s.seasonId === season && src === 1 && split === 0) {
      if (out.seasonProj == null) out.seasonProj = r1(s.appliedTotal);
    }
  }
  return out;
}

function playerRow(entry, p, ctx, extra = {}) {
  const sp = splits(p.stats, ctx.season, ctx.period);
  const nfl = PRO[p.proTeamId] ?? 'FA';
  const live = ctx.liveById[p.id];
  const inj = INJURY[p.injuryStatus];
  const note = ctx.injuryNotes[String(p.id)];

  /* This week's fixture comes from the NFL schedule, so a free agent gets one
     too. Points come from live scoring; the projection from live scoring for a
     rostered player and from the player's own weekly split otherwise. */
  let thisWeek;
  const fx = ctx.fixtures[nfl];
  if (ctx.byes[nfl] === ctx.period) thisWeek = { opponent: 'BYE' };
  else if (fx) {
    const state = live ? live.gameStatus : fx.state;
    thisWeek = clean({
      opponent: fx.home === nfl ? `vs ${fx.away}` : `@ ${fx.home}`,
      kickoff: fx.kickoff,
      game: state === 'final' ? 'final' : state === 'live' ? 'in progress' : null,
      points: live && live.gameStatus !== 'pre' ? r1(live.points) : null,
      projected: r1(live ? live.proj : sp.weekProj),
    });
  }
  const own = p.ownership || {};
  const rating = entry && entry.ratings && entry.ratings['0'];
  return clean({
    id: p.id,
    name: p.fullName,
    pos: POS[p.defaultPositionId] || 'FLEX',
    nflTeam: nfl,
    slot: extra.slot,
    injury: inj,
    injuryNote: inj && note ? note : undefined,
    bye: ctx.byes[nfl] || undefined,
    thisWeek,
    seasonPts: sp.seasonPts,
    seasonAvg: sp.seasonAvg,
    weekly: Object.keys(sp.weekly).length ? sp.weekly : undefined,
    posRank: rating && rating.positionalRanking ? rating.positionalRanking : undefined,
    rosProj: sp.rosProj,
    seasonProj: sp.rosProj == null ? sp.seasonProj : undefined,
    lastSeasonPts: sp.lastSeasonPts,
    owned: own.percentOwned != null ? r1(own.percentOwned) : undefined,
    ownedChange: own.percentChange ? r1(own.percentChange) : undefined,
    acquired: extra.acquired,
    availability: extra.availability,
    waiversClear: extra.waiversClear,
  });
}

/* NFL teams, the whole season's fixtures and this week's fixture per team, all
   from the bye-week digest, which already merges the 32 team schedules. */
function nflSection(byeDoc, positionAgainst, period, board) {
  const byes = (byeDoc && byeDoc.byes) || {};
  const info = (byeDoc && byeDoc.teams) || {};
  const teams = Object.keys(byes).sort().map((abbr) => clean({
    team: abbr,
    name: info[abbr] ? info[abbr].name : null,
    record: info[abbr] ? info[abbr].record || '0-0' : null,
    standing: info[abbr] ? info[abbr].standing || null : null,
    bye: byes[abbr] || null,
  }));

  /* The season schedule is refetched a few times a day, so this week's games
     come from the live scoreboard instead: an assistant reading the file during
     a Sunday should see the scores as they stand, not last night's fixtures
     with no result on them. */
  const boardWeek = board && Number(board.week) ? Number(board.week) : null;
  const liveThisWeek = boardWeek === Number(period) && Array.isArray(board.games) && board.games.length
    ? board.games : null;
  const schedule = {};
  const fixtures = {};
  const weeks = Object.keys((byeDoc && byeDoc.fixtures) || {}).map(Number).sort((a, b) => a - b);
  for (const week of weeks) {
    const list = [];
    for (const g of (week === Number(period) && liveThisWeek ? liveThisWeek : byeDoc.fixtures[week] || [])) {
      const kick = String(g.kickoff || '').replace(/\.\d{3}Z$/, 'Z');
      const state = g.final ? 'final' : g.inProgress ? 'live' : 'pre';
      list.push(g.final
        ? `${g.away} ${g.awayScore ?? '?'} @ ${g.home} ${g.homeScore ?? '?'}, final`
        : g.inProgress ? `${g.away} @ ${g.home}, in progress` : `${g.away} @ ${g.home}, ${kick}`);
      if (week === period) {
        const fx = { home: g.home, away: g.away, kickoff: kick, state };
        fixtures[g.home] = fx;
        fixtures[g.away] = fx;
      }
    }
    schedule[`week ${week}`] = list;
  }

  const dvp = {};
  const ratings = (positionAgainst && positionAgainst.positionalRatings) || {};
  for (const pos of POS_ORDER) {
    const posId = Object.keys(POS).find((k) => POS[k] === pos);
    const block = ratings[posId];
    if (!block) continue;
    dvp[pos] = Object.fromEntries(Object.entries(block.ratingsByOpponent || {})
      .filter(([id]) => PRO[id] && PRO[id] !== 'FA')
      .map(([id, v]) => [PRO[id], { rank: v.rank, avg: r1(v.average) }])
      .sort((a, b) => a[1].rank - b[1].rank));
  }
  return { byes, fixtures, section: { teams, schedule, pointsAllowedByPosition: dvp } };
}

/**
 * The export, from the free-agent pool's parts plus the named sources.
 * Throws when an essential source is missing, so the failure is recorded in the
 * dataset status rather than stored as a half-built file.
 */
export async function buildLlmExportDigest(ctx) {
  const src = ctx.sources || {};
  const settingsDoc = src.league_settings;
  const rosters = src.rosters;
  if (!settingsDoc || !settingsDoc.settings) throw new Error('league settings unavailable');
  if (!rosters || !Array.isArray(rosters.teams)) throw new Error('rosters unavailable');

  const now = ctx.now || Date.now();
  const status = settingsDoc.status || rosters.status || {};
  const season = settingsDoc.seasonId || rosters.seasonId;
  const period = rosters.scoringPeriodId || settingsDoc.scoringPeriodId;
  const matchupPeriod = status.currentMatchupPeriod || period;
  const regular = (settingsDoc.settings.scheduleSettings || {}).matchupPeriodCount || 0;
  const finalPeriod = status.finalScoringPeriod || 17;

  const pool = [];
  let positionAgainst = null;
  for (const part of ctx.teamIds || []) {
    const doc = await ctx.readPart(part);
    if (!doc) continue;
    if (!positionAgainst && doc.positionAgainstOpponent) positionAgainst = doc.positionAgainstOpponent;
    for (const e of doc.players || []) pool.push(e);
  }

  const nfl = nflSection(src.bye_weeks, positionAgainst, period, src.scoreboard_digest);

  const liveById = {};
  /* Only this matchup period's games. At a rollover the live digest can still
     describe the week just gone, and last week's points are not this week's. */
  const live = src.live_scoring_digest;
  const liveGames = ((live && live.games) || []).filter((g) => Number(g.period) === Number(matchupPeriod));
  for (const g of liveGames) {
    for (const side of [g.home, g.away]) {
      if (!side) continue;
      for (const p of [...(side.starters || []), ...(side.bench || [])]) liveById[p.id] = p;
    }
  }
  const injuryNotes = {};
  for (const p of (src.injuries_digest && src.injuries_digest.players) || []) {
    if (!injuryNotes[p.id] && p.note) injuryNotes[p.id] = p.note;
  }
  const ctxP = { season, period, liveById, injuryNotes, byes: nfl.byes, fixtures: nfl.fixtures };

  const standings = ((src.standings_digest && src.standings_digest.rows) || []).map((r) => clean({
    rank: r.rank,
    teamId: r.teamId,
    team: r.name,
    record: record(r.wins, r.losses, r.ties),
    pointsFor: r.pointsFor,
    pointsAgainst: r.pointsAgainst,
    streak: r.streak || null,
    playoffOdds: typeof r.playoffPct === 'number' ? `${Math.round(r.playoffPct * 100)}%` : null,
  }));

  const nameById = {};
  const teamsUi = [];
  const teams = rosters.teams.map((t) => {
    nameById[t.id] = t.name || `Team ${t.id}`;
    teamsUi.push({ id: t.id, name: nameById[t.id], logo: teamLogoUrl(t.id, t.logo) });
    const roster = ((t.roster && t.roster.entries) || []).map((e) => {
      const entry = e.playerPoolEntry || {};
      return [e.lineupSlotId, playerRow(entry, entry.player || {}, ctxP, {
        slot: SLOT[e.lineupSlotId] || String(e.lineupSlotId),
        acquired: ACQ[e.acquisitionType],
      })];
    }).sort((a, b) => idx(SLOT_ORDER, a[0]) - idx(SLOT_ORDER, b[0])).map((x) => x[1]);
    const tc = t.transactionCounter || {};
    return {
      teamId: t.id,
      name: nameById[t.id],
      waiverPriority: t.waiverRank || null,
      seasonMoves: { acquisitions: tc.acquisitions || 0, drops: tc.drops || 0, trades: tc.trades || 0 },
      roster,
    };
  });

  const side = (s) => clean({
    teamId: s.teamId,
    team: nameById[s.teamId] || s.name,
    points: r1(s.points),
    projected: r1(s.projected),
    winProbability: s.winProb != null ? `${s.winProb}%` : null,
  });
  const thisWeek = {
    week: period,
    matchups: liveGames.filter((g) => g.home && g.away).map((g) => clean({
      state: g.state === 'pre' ? 'not started' : g.state === 'live' ? 'in progress' : g.state,
      round: g.playoff || null,
      firstKickoff: g.firstKickoff || null,
      home: side(g.home),
      away: side(g.away),
    })),
  };

  const periods = (settingsDoc.settings.scheduleSettings || {}).matchupPeriods || {};
  const schedule = ((src.season_schedule && src.season_schedule.schedule) || []).map((m) => {
    // Settled means an earlier matchup period with points in it. ESPN's winner
    // stays UNDECIDED for days, so it is read only once the period has passed.
    const settled = m.matchupPeriodId < matchupPeriod && m.winner && m.winner !== 'UNDECIDED'
      && ((m.home && m.home.totalPoints) || (m.away && m.away.totalPoints));
    const s = (x) => (x ? clean({
      teamId: x.teamId, team: nameById[x.teamId], points: settled ? r1(x.totalPoints) : null,
    }) : { team: 'BYE' });
    const winnerSide = m.winner === 'HOME' ? m.home : m.winner === 'AWAY' ? m.away : null;
    return clean({
      week: m.matchupPeriodId,
      scoringWeeks: (periods[m.matchupPeriodId] || []).length > 1 ? periods[m.matchupPeriodId] : null,
      round: m.playoffTierType && m.playoffTierType !== 'NONE'
        ? m.playoffTierType.toLowerCase().replace(/_/g, ' ') : null,
      home: s(m.home),
      away: s(m.away),
      result: settled
        ? (m.winner === 'TIE' ? 'tie' : winnerSide ? `${nameById[winnerSide.teamId]} won` : null)
        : m.matchupPeriodId === matchupPeriod ? 'this week' : 'upcoming',
    });
  }).sort((a, b) => a.week - b.week);

  const value = (e) => {
    const sp = splits(e.player && e.player.stats, season, period);
    return sp.rosProj ?? sp.seasonProj ?? 0;
  };
  const freeAgents = [];
  const seenFa = new Set();
  for (const pos of POS_ORDER) {
    pool.filter((e) => e.player && POS[e.player.defaultPositionId] === pos && e.status !== 'ONTEAM')
      .filter((e) => (seenFa.has(e.player.id) ? false : seenFa.add(e.player.id)))
      .map((e) => [value(e), e]).sort((a, b) => b[0] - a[0]).slice(0, FREE_AGENT_DEPTH[pos])
      .forEach(([, e]) => {
        freeAgents.push(playerRow(e, e.player, ctxP, {
          availability: e.status === 'FREEAGENT' ? 'free agent' : 'on waivers',
          waiversClear: e.status === 'WAIVERS' && e.waiverProcessDate ? iso(e.waiverProcessDate) : null,
        }));
      });
  }

  const pn = (p) => `${p.name} (${p.pos}, ${p.nfl})`;
  const transactions = [];
  const tradeOffers = [];
  for (const it of (src.transaction_digest && src.transaction_digest.items) || []) {
    if (it.kind === 'trade') {
      const open = it.status === 'on_the_table' || it.status === 'pending_approval';
      (open ? tradeOffers : transactions).push(clean({
        type: 'trade',
        date: it.date,
        week: it.scoringPeriod,
        status: TRADE_STATUS[it.status] || it.status,
        sides: (it.sides || []).map((x) => ({
          teamId: x.team && x.team.id, team: x.team && x.team.name, sends: (x.players || []).map(pn),
        })),
      }));
    } else {
      const team = (it.teams || [])[0];
      transactions.push(clean({
        type: TX_KIND[it.kind] || it.kind,
        date: it.date,
        week: it.scoringPeriod,
        teamId: team ? team.id : null,
        team: team ? team.name : null,
        added: (it.adds || []).length ? it.adds.map(pn) : null,
        dropped: (it.drops || []).length ? it.drops.map(pn) : null,
      }));
    }
  }

  const hof = src.league_history_digest;
  const history = hof && Array.isArray(hof.rows) ? {
    champions: (hof.champions || []).filter((c) => !c.placeholder && c.teamId != null)
      .map((c) => ({ season: c.year, teamId: c.teamId, team: nameById[c.teamId] || null })),
    allTime: hof.rows.filter((r) => r.active).map((r) => ({
      teamId: r.teamId,
      team: nameById[r.teamId] || r.name,
      seasons: (r.seasons || []).length,
      record: record(r.record.wins, r.record.losses, r.record.ties),
      pointsPerGame: r.points ? r.points.perGame : null,
      championships: r.championships ? r.championships.count : 0,
      runnerUp: r.runnerUp ? r.runnerUp.count : 0,
      postseasonAppearances: r.postseason ? r.postseason.appearances : 0,
      averageFinish: r.avgFinish ?? null,
    })),
  } : null;

  const league = leagueSection(settingsDoc, rosters.teams.length);
  const exportDoc = {
    about: {
      source: 'ESPN Fantasy Tools, LLM Data Export',
      schemaVersion: SCHEMA_VERSION,
      version: 'full',
      generatedAt: iso(now),
      season,
      currentWeek: period,
      phase: period > finalPeriod ? 'season complete'
        : matchupPeriod > regular ? 'postseason' : 'regular season',
      conventions: [
        'All times are UTC, ISO 8601.',
        '"Week" means the fantasy scoring period. A postseason matchup can span two weeks.',
        'Points are fantasy points under the scoring rules in league.scoring.',
        'A player with no "injury" field is not on the injury report.',
        'teamId identifies a fantasy team throughout; names can change, ids do not.',
        'Projections are ESPN\'s. rosProj is rest of season.',
        'Pending waiver claims are never included, for any team.',
      ],
    },
    myTeam: null,
    league,
    standings,
    thisWeek,
    teams,
    schedule,
    freeAgents: {
      note: 'A shortlist, not every available player: the best available at each position by ESPN rest-of-season projection '
        + `(${FREE_AGENT_DEPTH.RB} each at RB and WR, ${FREE_AGENT_DEPTH.QB} each at QB, TE, D/ST and K).`,
      players: freeAgents,
    },
    transactions,
    tradeOffers,
    nfl: nfl.section,
    history,
  };

  return {
    generatedAt: new Date(now).toISOString(),
    count: teams.length,
    leagueName: league.name,
    teamsUi,
    export: exportDoc,
  };
}

/**
 * The stored export with this minute's scoring laid over it.
 *
 * Rebuilding the whole document takes several seconds: it reads every roster,
 * the free-agent pool and half a dozen digests. Nobody should wait that long
 * for a file, and almost none of it moves during a game. What does move is the
 * scoring, and that already arrives every minute in its own digest, so it is
 * patched over the stored copy instead. The rebuild still happens behind the
 * answer; this is what makes the copy in hand current in the meantime.
 */
export function applyLiveScoring(digest, live, now = Date.now()) {
  if (!digest || !digest.export || !live || !Array.isArray(live.games)) return digest;
  const doc = digest.export;
  const period = Number(doc.about && doc.about.currentWeek);
  const games = live.games.filter((g) => Number(g.period) === Number(live.matchupPeriod));
  if (!games.length || !period) return digest;

  const byPlayer = new Map();
  const sides = new Map();
  for (const g of games) {
    for (const side of [g.home, g.away]) {
      if (!side) continue;
      sides.set(side.teamId, { side, state: g.state, firstKickoff: g.firstKickoff });
      for (const p of [...(side.starters || []), ...(side.bench || [])]) byPlayer.set(p.id, p);
    }
  }

  const r1 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 10) / 10 : null);
  const patchPlayer = (p) => {
    const live1 = byPlayer.get(p.id);
    if (!live1 || !p.thisWeek) return p;
    const week = { ...p.thisWeek };
    week.projected = r1(live1.proj) ?? week.projected;
    if (live1.gameStatus === 'final') week.game = 'final';
    else if (live1.gameStatus === 'live') week.game = 'in progress';
    else delete week.game;
    if (live1.gameStatus !== 'pre') week.points = r1(live1.points);
    else delete week.points;
    return { ...p, thisWeek: week };
  };

  const patched = {
    ...doc,
    about: { ...doc.about, generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') },
    teams: doc.teams.map((t) => ({ ...t, roster: t.roster.map(patchPlayer) })),
    thisWeek: {
      ...doc.thisWeek,
      matchups: (doc.thisWeek.matchups || []).map((m) => {
        const home = sides.get(m.home && m.home.teamId);
        const away = sides.get(m.away && m.away.teamId);
        if (!home || !away) return m;
        const patchSide = (s, found) => ({
          ...s,
          points: r1(found.side.points),
          projected: r1(found.side.projected),
          winProbability: found.side.winProb != null ? `${found.side.winProb}%` : s.winProbability,
        });
        return {
          ...m,
          state: home.state === 'pre' ? 'not started' : home.state === 'live' ? 'in progress' : home.state,
          home: patchSide(m.home, home),
          away: patchSide(m.away, away),
        };
      }),
    },
  };
  if (doc.freeAgents) patched.freeAgents = { ...doc.freeAgents, players: doc.freeAgents.players.map(patchPlayer) };
  return { ...digest, generatedAt: patched.about.generatedAt, export: patched };
}

/**
 * What the route and the dev preview both send. One function, so a preview
 * cannot show a payload the signed-in page would not.
 */
export function llmExportPayload(raw, sim = null) {
  // Fortune Teller's odds are laid over here, the one shaping function the route and the preview share.
  const digest = applySimOdds(raw, sim);
  if (!digest || !digest.export || !Array.isArray(digest.export.teams) || !digest.export.teams.length) {
    return { ok: true, ready: false };
  }
  return {
    ok: true,
    ready: true,
    generatedAt: digest.generatedAt,
    leagueName: digest.leagueName,
    teamsUi: digest.teamsUi || [],
    export: digest.export,
  };
}

/**
 * Fortune Teller's simulated playoff odds beside ESPN's, once the simulation has run: the exact
 * share of every remaining combination of results in which the team makes the playoffs. Laid
 * over the stored export at request time, like live scoring, so it is never older than the map.
 */
export function applySimOdds(digest, sim) {
  if (!digest || !digest.export || !Array.isArray(digest.export.standings) || !sim) return digest;
  const fin = sim.final && sim.final.seasonOver ? sim.final.inByTeam : null;
  if (!sim.byTeam && !fin) return digest;
  const pct = (v) => (v >= 0.9995 ? 'clinched' : v <= 0.0005 ? 'eliminated' : `${Math.round(v * 1000) / 10}%`);
  const standings = digest.export.standings.map((r) => {
    let out = r;
    if (fin && fin[r.teamId] != null) out = { ...out, playoffOdds: fin[r.teamId] ? 'clinched' : 'eliminated' };   // the regular season is over
    if (sim.byTeam && sim.byTeam[r.teamId] != null) out = { ...out, simPlayoffOdds: pct(sim.byTeam[r.teamId]) };
    return out;
  });
  return { ...digest, export: { ...digest.export, standings } };
}
