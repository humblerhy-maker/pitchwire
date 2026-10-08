import { markKey, nextKey } from "./keys.server.ts";
import { eventsFromOddsApi, type ParsedEvent } from "./quotes.ts";

const BASE = "https://api.the-odds-api.com/v4";
const cache = new Map<string, { at: number; events: ParsedEvent[] }>();

interface SportRow {
  key?: unknown;
  group?: unknown;
  title?: unknown;
  active?: unknown;
}

export async function loadOneXBetEvents(groups: string[]): Promise<{ events: ParsedEvent[]; detail: string }> {
  const key = nextKey("odds-api");
  if (!key) return { events: [], detail: "The Odds API is disconnected. No 1xBet price is available." };
  try {
    const sportsRes = await fetch(`${BASE}/sports?apiKey=${encodeURIComponent(key.secret)}`, {
      signal: AbortSignal.timeout(8000),
    });
    const remaining = sportsRes.headers.get("x-requests-remaining");
    if (!sportsRes.ok) {
      markKey("odds-api", key.index, sportsRes.status === 401 ? "rejected" : "cooling", `HTTP ${sportsRes.status}`, 60_000);
      return { events: [], detail: `The Odds API HTTP ${sportsRes.status}. No prices were invented.` };
    }
    markKey("odds-api", key.index, "ok");
    const sports = (await sportsRes.json()) as SportRow[];
    const wanted = new Set(groups.map((group) => group.toLowerCase()));
    const keys = (Array.isArray(sports) ? sports : [])
      .filter((row) => row.active !== false && typeof row.key === "string" && typeof row.group === "string")
      .filter((row) => wanted.has(String(row.group).toLowerCase()))
      .map((row) => String(row.key))
      .slice(0, 3);
    if (keys.length === 0) {
      return { events: [], detail: "The Odds API returned no active sport key for this request. Remaining credits were not spent on odds." };
    }
    const events: ParsedEvent[] = [];
    for (const sportKey of keys) {
      const hit = cache.get(sportKey);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
        events.push(...hit.events);
        continue;
      }
      const url =
        `${BASE}/sports/${encodeURIComponent(sportKey)}/odds?regions=eu&bookmakers=onexbet` +
        `&markets=h2h,totals,spreads&oddsFormat=decimal&apiKey=${encodeURIComponent(key.secret)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 429) {
        markKey("odds-api", key.index, "cooling", "429", 60_000);
        return { events, detail: "The Odds API returned 429. Stopped. Cached prices, if any, are the only ones kept." };
      }
      if (!res.ok) {
        markKey("odds-api", key.index, "cooling", `HTTP ${res.status}`, 30_000);
        continue;
      }
      const parsed = eventsFromOddsApi(await res.json(), groupForKey(sportKey));
      const onex = parsed
        .map((event) => ({ ...event, quotes: event.quotes.filter((quote) => quote.is1xBet) }))
        .filter((event) => event.quotes.length > 0);
      cache.set(sportKey, { at: Date.now(), events: onex });
      events.push(...onex);
    }
    const left = remaining ? ` Sports-list credits remaining: ${remaining}.` : "";
    return {
      events,
      detail: events.length
        ? `1xBet prices from The Odds API bookmaker key onexbet.${left}`
        : `The Odds API responded, but no onexbet price was in the markets requested.${left}`,
    };
  } catch (err) {
    return { events: [], detail: err instanceof Error ? err.message : "Odds API request failed." };
  }
}

function groupForKey(key: string): string {
  if (key.startsWith("soccer")) return "football";
  if (key.startsWith("basketball")) return "basketball";
  if (key.startsWith("baseball")) return "baseball";
  if (key.startsWith("icehockey")) return "hockey";
  if (key.startsWith("tennis")) return "tennis";
  return key;
}

export function oddsGroupsFor(sports: string[] | "any"): string[] {
  if (sports === "any") return ["Soccer", "Basketball", "Baseball", "Ice Hockey"];
  const map: Record<string, string> = {
    football: "Soccer",
    basketball: "Basketball",
    baseball: "Baseball",
    hockey: "Ice Hockey",
    tennis: "Tennis",
  };
  return sports.map((sport) => map[sport]).filter((group): group is string => Boolean(group));
}
