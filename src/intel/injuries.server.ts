import { injuryFact, lookupTeam, parseEspnInjuryBoard, type InjuryTeam } from "./injuries.ts";

const FEEDS: Record<string, string> = {
  basketball: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries",
  baseball: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries",
  hockey: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries",
};

interface Cached {
  at: number;
  teams: InjuryTeam[] | null;
  detail: string;
}

const cache = new Map<string, Cached>();

async function board(sport: string): Promise<Cached> {
  const url = FEEDS[sport];
  if (!url) return { at: Date.now(), teams: null, detail: "No injury feed is connected for this sport." };
  const hit = cache.get(sport);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const row = { at: Date.now(), teams: null, detail: `${sport} injuries HTTP ${res.status}.` };
      cache.set(sport, row);
      return row;
    }
    const teams = parseEspnInjuryBoard(await res.json());
    const row = {
      at: Date.now(),
      teams,
      detail:
        teams == null
          ? `${sport} injury payload was not the expected board.`
          : teams.length === 0
            ? `${sport} injury board returned zero teams. That is not treated as a clean bill of health.`
            : `${sport} injury board: ${teams.length} teams.`,
    };
    cache.set(sport, row);
    return row;
  } catch (err) {
    const row = { at: Date.now(), teams: null, detail: err instanceof Error ? err.message : `${sport} injuries failed.` };
    cache.set(sport, row);
    return row;
  }
}

export async function loadInjuryContext(sports: string[]): Promise<{
  detail: string;
  forEvent: (sport: string, home: string, away: string) => { known: boolean; facts: string[] };
}> {
  const wanted = [...new Set(sports.filter((sport) => sport in FEEDS))];
  const boards = await Promise.all(wanted.map(async (sport) => [sport, await board(sport)] as const));
  const bySport = new Map(boards);
  return {
    detail: boards.map(([, row]) => row.detail).join(" ") || "Injury boards were not requested for this slate.",
    forEvent(sport, home, away) {
      const row = bySport.get(sport);
      if (!row || !row.teams) return { known: false, facts: [] };
      if (row.teams.length === 0) return { known: false, facts: [] };
      const homeHit = lookupTeam(row.teams, home);
      const awayHit = lookupTeam(row.teams, away);
      if (!homeHit.found || !awayHit.found) return { known: false, facts: [] };
      return { known: true, facts: [injuryFact(home, homeHit.rows), injuryFact(away, awayHit.rows)] };
    },
  };
}
