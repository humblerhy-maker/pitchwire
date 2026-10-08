export interface ScoringSample {
  team: string;
  games: number;
  scored: number;
  conceded: number;
}

/** ESPN summary `lastFiveGames`: team id plus home/away scores. Fewer than 3 games is not a rate. */
export function scoringFromLastFive(raw: unknown): ScoringSample[] {
  if (!Array.isArray(raw)) return [];
  const out: ScoringSample[] = [];
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
    for (const game of events) {
      if (!game || typeof game !== "object") continue;
      const g = game as { homeTeamId?: unknown; homeTeamScore?: unknown; awayTeamScore?: unknown };
      const homeScore = Number(g.homeTeamScore);
      const awayScore = Number(g.awayTeamScore);
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
      const isHome = String(g.homeTeamId) === id;
      scored += isHome ? homeScore : awayScore;
      conceded += isHome ? awayScore : homeScore;
      games += 1;
    }
    if (games >= 3) out.push({ team: name, games, scored, conceded });
  }
  return out;
}

export function scoringFact(samples: ScoringSample[]): string | null {
  if (samples.length < 2) return null;
  return samples
    .map((row) => `${row.team} last ${row.games}: ${row.scored} scored, ${row.conceded} conceded`)
    .join(". ");
}

export function verificationStatus(input: {
  eventFound: boolean;
  sameSide: boolean;
  lineMatched: boolean;
  issued: boolean;
  oppositeIssued: boolean;
}): "NOT IN FEED" | "LINE DIFFERENT" | "INSUFFICIENT" | "ALIGNED" | "DISAGREEMENT" {
  if (!input.eventFound) return "NOT IN FEED";
  if (input.sameSide && !input.lineMatched) return "LINE DIFFERENT";
  if (!input.sameSide) return "INSUFFICIENT";
  if (input.issued) return "ALIGNED";
  if (input.oppositeIssued) return "DISAGREEMENT";
  return "INSUFFICIENT";
}
