export interface GoalSample {
  team: string;
  games: number;
  scored: number;
  conceded: number;
  over15: number;
  over25: number;
  cleanSheets: number;
  failedToScore: number;
}

/** ESPN summary `lastFiveGames`. Fewer than 3 games is not a rate. */
export function profilesFromLastFive(raw: unknown): GoalSample[] {
  if (!Array.isArray(raw)) return [];
  const out: GoalSample[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const team = (row as { team?: { id?: unknown; displayName?: unknown } }).team;
    const name = typeof team?.displayName === "string" ? team.displayName : "";
    const id = team?.id != null ? String(team.id) : "";
    const events = (row as { events?: unknown }).events;
    if (!name || !id || !Array.isArray(events)) continue;
    let scored = 0;
    let conceded = 0;
    let games = 0;
    let over15 = 0;
    let over25 = 0;
    let cleanSheets = 0;
    let failedToScore = 0;
    for (const game of events) {
      if (!game || typeof game !== "object") continue;
      const g = game as { homeTeamId?: unknown; homeTeamScore?: unknown; awayTeamScore?: unknown };
      const homeScore = Number(g.homeTeamScore);
      const awayScore = Number(g.awayTeamScore);
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
      const isHome = String(g.homeTeamId) === id;
      const mine = isHome ? homeScore : awayScore;
      const theirs = isHome ? awayScore : homeScore;
      const total = homeScore + awayScore;
      scored += mine;
      conceded += theirs;
      games += 1;
      if (total > 1.5) over15 += 1;
      if (total > 2.5) over25 += 1;
      if (theirs === 0) cleanSheets += 1;
      if (mine === 0) failedToScore += 1;
    }
    if (games >= 3) out.push({ team: name, games, scored, conceded, over15, over25, cleanSheets, failedToScore });
  }
  return out;
}

/** Higher is stronger evidence. A short price is a penalty, never a reason to select. */
export function totalStrength(input: {
  games: number;
  overRate: number;
  combinedPerGame: number;
  decimal: number | null;
}): number {
  if (input.games < 3 || !Number.isFinite(input.overRate)) return -1;
  let score = input.overRate * 10;
  if (input.games >= 5) score += 1.5;
  else if (input.games >= 4) score += 0.5;
  if (input.combinedPerGame >= 3) score += 1.5;
  else if (input.combinedPerGame >= 2.4) score += 0.5;
  if (input.decimal != null && input.decimal > 1 && input.decimal < 1.4) score -= 3;
  return Math.round(score * 10) / 10;
}

export function goalPair(
  home: GoalSample,
  away: GoalSample,
  line: number,
  decimal: number | null,
): { overRate: number; homeRate: number; awayRate: number; strength: number; games: number; weakSide: number; combined: number } | null {
  if (line > 2.5) return null;
  const rate = (row: GoalSample) => (line <= 1.5 ? row.over15 : row.over25) / row.games;
  const homeRate = rate(home);
  const awayRate = rate(away);
  const overRate = (homeRate + awayRate) / 2;
  const games = Math.min(home.games, away.games);
  const combined =
    [home, away].reduce((sum, row) => sum + (row.scored + row.conceded) / row.games, 0) / 2;
  const weakSide = Math.min(homeRate, awayRate);
  return {
    overRate,
    homeRate,
    awayRate,
    games,
    weakSide,
    combined,
    strength: totalStrength({ games, overRate, combinedPerGame: combined, decimal }),
  };
}

/** Issue bar. Review can include weaker samples. This bar is what may be returned. */
export function passesGoalScreen(input: { strength: number; games: number; overRate: number; weakSide: number }): boolean {
  return input.games >= 4 && input.overRate >= 0.6 && input.weakSide >= 0.4 && input.strength >= 8;
}

export function strengthLabel(strength: number, confirmed: boolean): string {
  if (!confirmed) return "Screened, not model-confirmed";
  if (strength >= 9) return "Strongest available";
  if (strength >= 8) return "Supported";
  return "Borderline";
}
