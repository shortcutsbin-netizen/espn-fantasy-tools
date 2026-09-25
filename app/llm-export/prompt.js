/**
 * The prompt that goes with the file.
 *
 * Markdown, so it pastes cleanly into any assistant. Written for any assistant, not one product. It names the file's sections in
 * the order they appear, defines every field a reader could misread, sets the
 * ground rules, and asks for a briefing before anything else.
 */

export function buildPrompt(doc, { fileName = 'the attached file' } = {}) {
  const a = doc.about || {};
  const lg = doc.league || {};
  const me = doc.myTeam;
  const compact = a.version === 'compact';
  const league = lg.name ? `**${lg.name}**` : 'my league';
  const who = me
    ? `My team is **${me.team}** (\`teamId\` ${me.teamId}). The file marks it in \`myTeam\` and with \`"isMyTeam": true\` in \`teams\`.`
    : '**I haven\'t said which team is mine yet.** Before anything else, ask me which team in `teams` is mine, and wait for the answer.';

  return `You are my fantasy football assistant for ${league}, a ${lg.teams || ''}-team ESPN league (${lg.format || 'head-to-head points'}). I've attached a ${compact ? 'compact ' : ''}JSON export of the whole league (${fileName}); if you can't see an attachment, it's pasted after this message. It was generated at ${a.generatedAt || 'an unknown time'} (UTC), during week ${a.currentWeek ?? '?'} of the ${a.season || ''} ${a.phase || 'season'}.

${who}

${sections(doc)}

## How to read a player
${glossary(doc)}

## Ground rules
- The file is the source of truth. Don't invent players, stats, injuries, depth-chart roles or news that aren't in it. If you bring in anything from your own knowledge, say so clearly, and remember it may be out of date.
- The file is a snapshot. Anything after the time it was generated isn't in it. When an answer depends on something that could have changed since (an injury update, a waiver run, a trade), say so. I can export a fresh file at any time.
- Use this league's scoring and roster rules, not generic ones. Check \`league.scoring\` before comparing players, and \`league.lineup\` and \`league.positionMaximums\` before suggesting moves.
- A roster that is full needs a drop for every add. Say who to drop.
- Players lock at their own game's kickoff when \`league.lineupLock\` says so. Don't suggest moving a player whose game has already started.
- Plan around bye weeks, and for longer-term decisions look ahead to the postseason weeks listed in \`league.season\`.
- For trades, look at both rosters and suggest deals the other team has a reason to accept. Nobody accepts a lopsided offer.
- Pending waiver claims are never in the file, for any team, including mine.
- When you recommend something, name the exact players, give the reasons from the data (projections, recent weeks, matchup ranks, byes, injuries) and the main risk. Use a small table when comparing players.
- Be direct and brief. If a question is ambiguous, ask one short question instead of guessing.

## First step
Read the entire file, then reply with a short briefing and nothing else:

1. The league in a few lines: scoring, lineup, waivers and the postseason format, plus anything unusual worth remembering.
2. ${me ? 'Where my team stands' : 'Once you know which team is mine, where it stands'}: record, rank, playoff odds, and points for and against compared with the rest of the league.
3. My roster: strengths, weak spots, injuries, and bye-week problems coming up.
4. This week: my opponent, projected scores, win probability, and any start/sit decisions worth a second look.
5. The three available players who would help my team most, and who I'd drop for each.
6. Anything else notable around the league: recent trades, streaks, standout pickups.

**Then stop and wait for my first question.**`;
}


/* Section descriptions, in file order, for the sections actually present. */
const SECTION_TEXT = {
  about: () => 'when the export was made, the current week, and conventions used throughout. Read it first.',
  myTeam: () => 'which team is mine, where it stands, and who I play this week.',
  league: () => 'the rules: starting lineup slots, roster size and position maximums, the complete scoring system, lineup locking, the postseason format, and waiver and trade rules.',
  standings: () => 'rank, record, points for and against, streak and ESPN\'s playoff odds for every team, plus `simPlayoffOdds` once Fortune Teller has run: the exact share of every remaining combination of results in which the team makes the playoffs.',
  thisWeek: () => 'this week\'s fantasy matchups with current points, projected points and win probability.',
  teams: (c) => (c ? 'every team\'s waiver priority and full roster in lineup order.'
    : 'every team\'s waiver priority, moves made this season, and full roster in lineup order.'),
  schedule: (c) => (c ? 'the fantasy matchups still to be played, starting with this week.'
    : 'every fantasy matchup this season, with scores and winners for completed weeks.'),
  freeAgents: () => 'a shortlist of the best available players at each position. It is not every available player.',
  transactions: (c) => (c ? 'moves from this week and last week: waiver claims, free-agent adds and drops, and trades, including proposals that were withdrawn, rejected or expired.'
    : 'this season\'s completed moves (waiver claims, free-agent adds and drops, trades) and trade proposals that were withdrawn, rejected or expired.'),
  tradeOffers: () => 'trade proposals that are still open.',
  nfl: (c) => (c ? 'every NFL team\'s record and bye week, this week\'s and next week\'s NFL games, and `pointsAllowedByPosition`, which ranks every NFL defense against each position.'
    : 'every NFL team\'s record, standing and bye week; the full NFL schedule by week with final scores; and `pointsAllowedByPosition`, which ranks every NFL defense by the fantasy points it allows to each position.'),
  history: () => 'past champions and each current team\'s all-time record.',
};

function sections(doc) {
  const c = doc.about && doc.about.version === 'compact';
  const lines = Object.keys(doc).filter((k) => SECTION_TEXT[k])
    .map((k) => `- \`${k}\`: ${SECTION_TEXT[k](c)}`);
  return `## What's in the file\n${lines.join('\n')}`;
}

function glossary(doc) {
  const c = doc.about && doc.about.version === 'compact';
  const rows = [
    '- `slot`: where the player sits in the lineup now. "Bench" and "IR" are not starting.',
    c ? '- `injury`: only present when the player is on the injury report. No injury field means healthy.'
      : '- `injury` / `injuryNote`: only present when the player is on the injury report. No injury field means healthy.',
    '- `bye`: the NFL week this player\'s team doesn\'t play.',
    c ? '- `thisWeek`: opponent ("vs" = home, "@" = away), game state once it has started, points scored so far, and ESPN\'s projection for the week.'
      : '- `thisWeek`: opponent ("vs" = home, "@" = away), kickoff, game state once it has started, points scored so far, and ESPN\'s projection for the week.',
    c ? '- `seasonAvg`: fantasy points per game this season under this league\'s scoring.'
      : '- `seasonPts` / `seasonAvg` / `weekly`: fantasy points this season, per game, and week by week under this league\'s scoring.',
    '- `posRank`: the player\'s rank at his position this season.',
    '- `rosProj`: ESPN\'s projection for the rest of the season. `seasonProj` appears only when there is no rest-of-season figure.',
  ];
  if (!c) {
    rows.push('- `lastSeasonPts`: last season\'s total.');
    rows.push('- `owned` / `ownedChange`: percent of all ESPN leagues rostering the player, and the recent change. A big positive change means people are picking him up.');
    rows.push('- `acquired`: how a rostered player joined his team (draft, pickup or trade).');
  }
  rows.push('- `availability`: for free agents. "on waivers" means he has to be claimed through the waiver process; "free agent" means he can be added immediately.');
  rows.push(c ? '- In `pointsAllowedByPosition`, each NFL team\'s value is its rank: 1 allows the fewest fantasy points to that position (the toughest matchup), 32 the most. Early in the season these rest on very few games.'
    : '- In `pointsAllowedByPosition`, rank 1 allows the fewest points (the toughest matchup) and higher ranks are easier. `avg` is fantasy points allowed per game. Early in the season these rest on very few games.');
  rows.push('- Teams are identified by `teamId`. Always refer to teams by name when you answer.');
  return rows.join('\n');
}
