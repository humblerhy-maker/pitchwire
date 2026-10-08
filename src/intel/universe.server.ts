import { eventsFromEspnScoreboard, type ParsedEvent } from "./quotes.ts";
import { localDayRange, type TimeWindow } from "./intent.ts";

export interface UniverseDiag {
  leaguesKnown: number;
  scoreboardsRead: number;
  scoreboardErrors: number;
  eventsDiscovered: number;
  eventsDeduped: number;
  addedBeyondAggregate: number;
  datesQueried: string[];
  note: string;
}

const leagueCache: { at: number; slugs: string[] } = { at: 0, slugs: [] };
const boardCache = new Map<string, { at: number; events: ParsedEvent[]; diag: UniverseDiag }>();

async function leagueSlugs(): Promise<string[]> {
  if (leagueCache.slugs.length && Date.now() - leagueCache.at < 6 * 3600 * 1000) return leagueCache.slugs;
  const slugs: string[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await fetch(`https://sports.core.api.espn.com/v2/sports/soccer/leagues?limit=200&page=${page}`, {
      headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) break;
    const json = (await res.json()) as { items?: Array<{ $ref?: string }> };
    const items = json.items ?? [];
    if (!items.length) break;
    for (const item of items) {
      const match = item.$ref?.match(/leagues\/([^?]+)/);
      if (match?.[1]) slugs.push(decodeURIComponent(match[1]));
    }
    if (items.length < 200) break;
  }
  leagueCache.at = Date.now();
  leagueCache.slugs = slugs;
  return slugs;
}

function ymd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function datesFor(window: TimeWindow, now: Date): string[] {
  const range = localDayRange(window, now);
  if (!range) {
    const t = ymd(now.getTime());
    return [t];
  }
  const a = ymd(range.start);
  const b = ymd(range.end - 1);
  return a === b ? [a] : [a, b];
}

async function fetchBoard(url: string, sport: string): Promise<ParsedEvent[]> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(String(res.status));
  return eventsFromEspnScoreboard(await res.json(), sport, "espn-scoreboard");
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
}

/**
 * Worldwide public slate for the local day.
 * ESPN's aggregated soccer scoreboard is the baseline. Every known soccer league
 * scoreboard for the same dates is also read, and only new event ids are added.
 */
export async function loadUniverse(window: TimeWindow, now = new Date()): Promise<{ events: ParsedEvent[]; diag: UniverseDiag }> {
  const dates = datesFor(window, now);
  const key = `${window}:${dates.join(",")}`;
  const hit = boardCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return { events: hit.events, diag: hit.diag };

  const slugs = await leagueSlugs().catch(() => [] as string[]);
  const byId = new Map<string, ParsedEvent>();
  let scoreboardsRead = 0;
  let scoreboardErrors = 0;
  let aggregate = 0;

  for (const date of dates) {
    try {
      const events = await fetchBoard(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${date}&limit=500`,
        "football",
      );
      scoreboardsRead += 1;
      for (const event of events) {
        if (!byId.has(event.providerEventId)) byId.set(event.providerEventId, event);
      }
    } catch {
      scoreboardErrors += 1;
    }
  }
  aggregate = byId.size;

  let addedBeyondAggregate = 0;
  let truncated = false;
  let leagueDatesAttempted = 0;
  const deadline = Date.now() + 45_000;
  await pool(slugs, 24, async (slug) => {
    if (Date.now() > deadline) {
      truncated = true;
      return;
    }
    for (const date of dates) {
      if (Date.now() > deadline) {
        truncated = true;
        return;
      }
      leagueDatesAttempted += 1;
      try {
        const events = await fetchBoard(
          `https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(slug)}/scoreboard?dates=${date}`,
          "football",
        );
        scoreboardsRead += 1;
        for (const event of events) {
          if (!byId.has(event.providerEventId)) {
            byId.set(event.providerEventId, event);
            addedBeyondAggregate += 1;
          }
        }
      } catch {
        scoreboardErrors += 1;
      }
    }
  });

  for (const sport of [
    ["basketball", "basketball/nba"],
    ["baseball", "baseball/mlb"],
    ["hockey", "hockey/nhl"],
  ] as const) {
    for (const date of dates) {
      try {
        const events = await fetchBoard(
          `https://site.api.espn.com/apis/site/v2/sports/${sport[1]}/scoreboard?dates=${date}`,
          sport[0],
        );
        scoreboardsRead += 1;
        for (const event of events) {
          const id = `${sport[0]}:${event.providerEventId}`;
          const existing = byId.get(id);
          if (!existing) byId.set(id, event);
          else {
            const seen = new Set(existing.quotes.map((quote) => `${quote.bookmaker}|${quote.market}|${quote.selection}|${quote.line ?? ""}`));
            for (const quote of event.quotes) {
              const key = `${quote.bookmaker}|${quote.market}|${quote.selection}|${quote.line ?? ""}`;
              if (!seen.has(key)) existing.quotes.push(quote);
            }
          }
        }
      } catch {
        scoreboardErrors += 1;
      }
    }
    try {
      const events = await fetchBoard(`https://site.api.espn.com/apis/site/v2/sports/${sport[1]}/scoreboard`, sport[0]);
      scoreboardsRead += 1;
      for (const event of events) {
        const id = `${sport[0]}:${event.providerEventId}`;
        const existing = byId.get(id);
        if (!existing) byId.set(id, event);
        else {
          const seen = new Set(existing.quotes.map((quote) => `${quote.bookmaker}|${quote.market}|${quote.selection}|${quote.line ?? ""}`));
          for (const quote of event.quotes) {
            const key = `${quote.bookmaker}|${quote.market}|${quote.selection}|${quote.line ?? ""}`;
            if (!seen.has(key)) existing.quotes.push(quote);
          }
        }
      }
    } catch {
      scoreboardErrors += 1;
    }
  }

  const events = [...byId.values()];
  const diag: UniverseDiag = {
    leaguesKnown: slugs.length,
    scoreboardsRead,
    scoreboardErrors,
    eventsDiscovered: events.length,
    eventsDeduped: events.length,
    addedBeyondAggregate,
    datesQueried: dates,
    note:
      slugs.length > 0
        ? `Aggregated scoreboard listed ${aggregate} football events before the league sweep. ${slugs.length} leagues are known. The sweep attempted ${leagueDatesAttempted} league-dates${truncated ? " and stopped at the time limit, so the slate is incomplete" : ""}. Added ${addedBeyondAggregate} events that were not already on the aggregate. ${scoreboardErrors} boards failed. This is the reachable public slate, not every match on earth.`
        : "League list failed. Only the aggregated scoreboard was used.",
  };
  boardCache.set(key, { at: Date.now(), events, diag });
  return { events, diag };
}
