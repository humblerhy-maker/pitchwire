import { canonicalName } from "../engine/ids.ts";
import { americanToDecimal, impliedFromDecimal, parseAmerican, round4 } from "./odds-math.ts";

export interface Quote {
  market: "h2h" | "total" | "spread";
  selection: string;
  line: number | null;
  decimal: number;
  american: number | null;
  implied: number;
  bookmaker: string;
  is1xBet: boolean;
  source: string;
  /** Wall clock on the price itself. Null when the payload has none. */
  providerTimestamp: string | null;
  openDecimal: number | null;
  note: string;
}

export interface ParsedEvent {
  sport: string;
  competition: string | null;
  providerEventId: string;
  home: string;
  away: string;
  start: string | null;
  state: "pre" | "in" | "post" | "other";
  clock: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  recordHome: string | null;
  recordAway: string | null;
  pitcherHome: string | null;
  pitcherAway: string | null;
  quotes: Quote[];
  source: string;
}

const ONEXBET = new Set(["onexbet", "1xbet", "1x bet"]);

export function isOneXBetName(name: string): boolean {
  return ONEXBET.has(name.trim().toLowerCase());
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function recordOf(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const summary = row && typeof row === "object" ? (row as { summary?: unknown }).summary : null;
    if (typeof summary === "string" && /^\d+-\d+/.test(summary)) return summary;
  }
  return null;
}

function sidePrice(node: unknown): { close: number | null; open: number | null; line: number | null } {
  if (!node || typeof node !== "object") return { close: null, open: null, line: null };
  const side = node as { close?: { odds?: unknown; line?: unknown }; open?: { odds?: unknown; line?: unknown } };
  const closeOdds = parseAmerican(side.close?.odds);
  const openOdds = parseAmerican(side.open?.odds);
  const lineText = typeof side.close?.line === "string" ? side.close.line : "";
  const line = /off/i.test(lineText) ? null : num(lineText.replace(/^[ou]/i, "").replace(/^\+/, ""));
  return { close: closeOdds, open: openOdds, line };
}

function quoteFromAmerican(input: {
  market: Quote["market"];
  selection: string;
  line: number | null;
  american: number;
  openAmerican: number | null;
  bookmaker: string;
  source: string;
}): Quote | null {
  const decimal = americanToDecimal(input.american);
  const implied = decimal ? impliedFromDecimal(decimal) : null;
  if (!decimal || !implied) return null;
  const openDecimal = input.openAmerican != null ? americanToDecimal(input.openAmerican) : null;
  return {
    market: input.market,
    selection: input.selection,
    line: input.line,
    decimal: round4(decimal),
    american: input.american,
    implied: round4(implied),
    bookmaker: input.bookmaker,
    is1xBet: isOneXBetName(input.bookmaker),
    source: input.source,
    providerTimestamp: null,
    openDecimal: openDecimal ? round4(openDecimal) : null,
    note: isOneXBetName(input.bookmaker)
      ? "Price came from a feed whose bookmaker field is 1xBet."
      : `Close price from ${input.bookmaker}. This is not a 1xBet price.`,
  };
}

/** ESPN scoreboard odds. Verified shape on 2026-10-07: provider DraftKings, moneyline/total/pointSpread close+open. */
export function quotesFromEspnOdds(odds: unknown, home: string, away: string): Quote[] {
  if (!Array.isArray(odds)) return [];
  const out: Quote[] = [];
  for (const row of odds) {
    if (!row || typeof row !== "object") continue;
    const block = row as {
      provider?: { name?: unknown; displayName?: unknown };
      moneyline?: { home?: unknown; away?: unknown; draw?: unknown };
      total?: { over?: unknown; under?: unknown };
      pointSpread?: { home?: unknown; away?: unknown };
    };
    const book =
      (typeof block.provider?.displayName === "string" && block.provider.displayName) ||
      (typeof block.provider?.name === "string" && block.provider.name) ||
      "";
    if (!book) continue;
    const ml = [
      ["home", home, block.moneyline?.home],
      ["away", away, block.moneyline?.away],
      ["draw", "Draw", block.moneyline?.draw],
    ] as const;
    for (const [, selection, node] of ml) {
      const price = sidePrice(node);
      if (price.close == null) continue;
      const quote = quoteFromAmerican({
        market: "h2h",
        selection,
        line: null,
        american: price.close,
        openAmerican: price.open,
        bookmaker: book,
        source: "espn-scoreboard",
      });
      if (quote) out.push(quote);
    }
    for (const [selection, node] of [
      ["Over", block.total?.over],
      ["Under", block.total?.under],
    ] as const) {
      const price = sidePrice(node);
      if (price.close == null || price.line == null) continue;
      const quote = quoteFromAmerican({
        market: "total",
        selection,
        line: price.line,
        american: price.close,
        openAmerican: price.open,
        bookmaker: book,
        source: "espn-scoreboard",
      });
      if (quote) out.push(quote);
    }
    for (const [selection, node] of [
      [home, block.pointSpread?.home],
      [away, block.pointSpread?.away],
    ] as const) {
      const price = sidePrice(node);
      if (price.close == null || price.line == null) continue;
      const quote = quoteFromAmerican({
        market: "spread",
        selection,
        line: price.line,
        american: price.close,
        openAmerican: price.open,
        bookmaker: book,
        source: "espn-scoreboard",
      });
      if (quote) out.push(quote);
    }
  }
  return out;
}

export function eventsFromEspnScoreboard(raw: unknown, sport: string, source: string): ParsedEvent[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { events?: unknown }).events)) return [];
  const events: ParsedEvent[] = [];
  for (const event of (raw as { events: unknown[] }).events) {
    if (!event || typeof event !== "object") continue;
    const ev = event as {
      id?: unknown;
      name?: unknown;
      date?: unknown;
      competitions?: unknown[];
      status?: { type?: { state?: unknown; shortDetail?: unknown } };
      season?: { slug?: unknown };
    };
    const comp = Array.isArray(ev.competitions) ? ev.competitions[0] : null;
    if (!comp || typeof comp !== "object") continue;
    const c = comp as { competitors?: unknown[]; odds?: unknown };
    const competitors = Array.isArray(c.competitors) ? c.competitors : [];
    const home = competitors.find((row) => isSide(row, "home"));
    const away = competitors.find((row) => isSide(row, "away"));
    if (!home || !away) continue;
    const homeName = teamName(home);
    const awayName = teamName(away);
    if (!homeName || !awayName) continue;
    const stateRaw = typeof ev.status?.type?.state === "string" ? ev.status.type.state : "other";
    const state = stateRaw === "pre" || stateRaw === "in" || stateRaw === "post" ? stateRaw : "other";
    events.push({
      sport,
      competition: competitionOf(raw, ev),
      providerEventId: typeof ev.id === "string" ? ev.id : `${homeName}|${awayName}|${ev.date ?? ""}`,
      home: homeName,
      away: awayName,
      start: typeof ev.date === "string" ? ev.date : null,
      state,
      clock: typeof ev.status?.type?.shortDetail === "string" ? ev.status.type.shortDetail : null,
      scoreHome: num((home as { score?: unknown }).score),
      scoreAway: num((away as { score?: unknown }).score),
      recordHome: recordOf((home as { records?: unknown }).records),
      recordAway: recordOf((away as { records?: unknown }).records),
      pitcherHome: pitcherOf(home),
      pitcherAway: pitcherOf(away),
      quotes: quotesFromEspnOdds(c.odds, homeName, awayName),
      source,
    });
  }
  return events;
}

function competitionOf(raw: unknown, event: { name?: unknown; season?: { slug?: unknown } }): string | null {
  if (typeof event.season?.slug === "string" && event.season.slug.trim()) {
    return event.season.slug.replace(/-/g, " ");
  }
  const leagues = raw && typeof raw === "object" ? (raw as { leagues?: Array<{ name?: unknown; abbreviation?: unknown }> }).leagues : null;
  const league = Array.isArray(leagues) && leagues.length === 1 ? leagues[0] : null;
  if (typeof league?.abbreviation === "string") return league.abbreviation;
  if (typeof league?.name === "string") return league.name;
  return typeof event.name === "string" ? event.name : null;
}

function pitcherOf(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const probs = (row as { probables?: unknown }).probables;
  if (!Array.isArray(probs)) return null;
  for (const item of probs) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown; athlete?: { displayName?: unknown } }).name;
    const athlete = (item as { athlete?: { displayName?: unknown } }).athlete?.displayName;
    if ((name === "probableStartingPitcher" || name === "probable") && typeof athlete === "string") return athlete;
  }
  return null;
}

function isSide(row: unknown, side: "home" | "away"): boolean {
  return !!row && typeof row === "object" && (row as { homeAway?: unknown }).homeAway === side;
}

function teamName(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const team = (row as { team?: { displayName?: unknown } }).team;
  return typeof team?.displayName === "string" ? team.displayName : null;
}

export function eventKey(event: { home: string; away: string; start: string | null }): string {
  const hour = event.start ? event.start.slice(0, 13) : "na";
  return `${canonicalName(event.home)}|${canonicalName(event.away)}|${hour}`;
}

export interface OddsApiEvent {
  id?: unknown;
  sport_key?: unknown;
  sport_title?: unknown;
  commence_time?: unknown;
  home_team?: unknown;
  away_team?: unknown;
  bookmakers?: unknown;
}

/** The Odds API v4 odds document. 1xBet is bookmaker key `onexbet` in region `eu`. */
export function eventsFromOddsApi(rows: unknown, sport: string): ParsedEvent[] {
  if (!Array.isArray(rows)) return [];
  const events: ParsedEvent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const ev = row as OddsApiEvent;
    const home = typeof ev.home_team === "string" ? ev.home_team : "";
    const away = typeof ev.away_team === "string" ? ev.away_team : "";
    if (!home || !away) continue;
    const quotes: Quote[] = [];
    const books = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];
    for (const book of books) {
      if (!book || typeof book !== "object") continue;
      const b = book as { key?: unknown; title?: unknown; last_update?: unknown; markets?: unknown };
      const title = typeof b.title === "string" ? b.title : typeof b.key === "string" ? b.key : "";
      if (!title) continue;
      const markets = Array.isArray(b.markets) ? b.markets : [];
      for (const market of markets) {
        if (!market || typeof market !== "object") continue;
        const m = market as { key?: unknown; outcomes?: unknown };
        const key = m.key === "h2h" || m.key === "totals" || m.key === "spreads" ? m.key : null;
        if (!key || !Array.isArray(m.outcomes)) continue;
        for (const outcome of m.outcomes) {
          if (!outcome || typeof outcome !== "object") continue;
          const o = outcome as { name?: unknown; price?: unknown; point?: unknown };
          const price = typeof o.price === "number" ? o.price : null;
          const implied = price ? impliedFromDecimal(price) : null;
          if (!price || !implied || price <= 1) continue;
          const marketId = key === "totals" ? "total" : key === "spreads" ? "spread" : "h2h";
          quotes.push({
            market: marketId,
            selection: typeof o.name === "string" ? o.name : "",
            line: typeof o.point === "number" ? o.point : null,
            decimal: round4(price),
            american: null,
            implied: round4(implied),
            bookmaker: title,
            is1xBet: isOneXBetName(title) || b.key === "onexbet",
            source: "the-odds-api",
            providerTimestamp: typeof b.last_update === "string" ? b.last_update : null,
            openDecimal: null,
            note:
              b.key === "onexbet" || isOneXBetName(title)
                ? "The Odds API v4 bookmaker key onexbet. Their bookmaker table maps that key to 1xBet."
                : `The Odds API price from ${title}. Not labeled 1xBet.`,
          });
        }
      }
    }
    events.push({
      sport,
      competition: typeof ev.sport_title === "string" ? ev.sport_title : null,
      providerEventId: typeof ev.id === "string" ? ev.id : `${home}|${away}`,
      home,
      away,
      start: typeof ev.commence_time === "string" ? ev.commence_time : null,
      state: "pre",
      clock: null,
      scoreHome: null,
      scoreAway: null,
      recordHome: null,
      recordAway: null,
      pitcherHome: null,
      pitcherAway: null,
      quotes: quotes.filter((quote) => quote.selection),
      source: "the-odds-api",
    });
  }
  return events;
}

export function mergeEvents(base: ParsedEvent[], extra: ParsedEvent[]): ParsedEvent[] {
  const byKey = new Map<string, ParsedEvent>();
  for (const event of base) byKey.set(eventKey(event), { ...event, quotes: [...event.quotes] });
  for (const event of extra) {
    const key = eventKey(event);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }
    const seen = new Set(existing.quotes.map(quoteId));
    for (const quote of event.quotes) {
      const id = quoteId(quote);
      if (seen.has(id)) continue;
      existing.quotes.push(quote);
      seen.add(id);
    }
  }
  return [...byKey.values()];
}

function quoteId(quote: Quote): string {
  return `${quote.bookmaker}|${quote.market}|${quote.selection}|${quote.line ?? ""}`;
}
