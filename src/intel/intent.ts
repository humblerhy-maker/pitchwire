export type SportId = "football" | "basketball" | "baseball" | "hockey" | "tennis" | "volleyball" | "table-tennis";

export type TimeWindow = "today" | "tomorrow" | "tonight" | "midnight" | "upcoming";

export interface FinderIntent {
  raw: string;
  sports: SportId[] | "any";
  count: number | null;
  combinedTarget: number | null;
  liveOnly: boolean;
  window: TimeWindow;
  marketHint: string | null;
  /** Goal line for football totals, e.g. 1.5. Null when the user did not name one. */
  line: number | null;
  side: "over" | "under" | null;
  /** "Sure" means strongest available evidence, never certainty. */
  preferEvidence: boolean;
}

const SPORT_WORDS: Array<[RegExp, SportId]> = [
  [/\b(table\s*tennis|ping\s*pong)\b/i, "table-tennis"],
  [/\b(volleyball)\b/i, "volleyball"],
  [/\b(tennis)\b/i, "tennis"],
  [/\b(basketball|nba)\b/i, "basketball"],
  [/\b(baseball|mlb)\b/i, "baseball"],
  [/\b(hockey|nhl)\b/i, "hockey"],
  [/\b(football|soccer)\b/i, "football"],
];

export const USER_TIMEZONE = "Africa/Lagos";

export function parseFinderIntent(raw: string): FinderIntent {
  const text = raw.trim();
  const sports = new Set<SportId>();
  for (const [pattern, sport] of SPORT_WORDS) {
    if (pattern.test(text)) sports.add(sport);
  }
  const lineMatch = text.match(/\b(over|under)\s+(\d+(?:\.\d+)?)\b/i);
  const side = lineMatch ? (lineMatch[1]!.toLowerCase() as "over" | "under") : null;
  const line = lineMatch ? Number(lineMatch[2]) : null;
  const goalMarket = side != null && line != null;
  if (goalMarket && sports.size === 0) sports.add("football");

  const any =
    sports.size === 0 ||
    /\b(any sport|other sports|across sports|you may use other)\b/i.test(text);
  const only = /\bonly\b/i.test(text) && sports.size > 0;

  let combinedTarget: number | null = null;
  const oddsPhrase = text.match(/\b(\d+(?:\.\d+)?)\s*odds\b/i);
  const around = text.match(/\b(?:around|about|approx(?:imately)?|total)\s+(\d+(?:\.\d+)?)\b/i);
  if (oddsPhrase && !goalMarket) combinedTarget = Number(oddsPhrase[1]);
  else if (around && /\bodds\b/i.test(text) && !goalMarket) combinedTarget = Number(around[1]);

  let count: number | null = null;
  const sureCount = text.match(/\b(\d+)\s+sure\b/i);
  const overCount = text.match(/\b(\d+)\s+(?:over|under)\b/i);
  const countPhrase = text.match(/\b(\d+)\s+(?:strongest|selections?|picks?|games?|legs?|markets?)\b/i);
  if (sureCount) count = Number(sureCount[1]);
  else if (overCount) count = Number(overCount[1]);
  else if (countPhrase && !oddsPhrase) count = Number(countPhrase[1]);

  let window: TimeWindow = "today";
  if (/\btomorrow\b/i.test(text)) window = "tomorrow";
  else if (/\bmidnight\b/i.test(text)) window = "midnight";
  else if (/\btonight\b/i.test(text)) window = "tonight";
  else if (/\b(upcoming|this week)\b/i.test(text)) window = "upcoming";

  let marketHint: string | null = null;
  if (/\bcorners?\b/i.test(text)) marketHint = "corners";
  else if (/\bbtts|both teams to score\b/i.test(text)) marketHint = "btts";
  else if (goalMarket) marketHint = "total";
  else if (/\b(over|under)\b/i.test(text) || /\btotals?\b(?!\s+odds)/i.test(text)) marketHint = "total";
  else if (/\b(spread|handicap)\b/i.test(text)) marketHint = "spread";
  else if (/\b(moneyline|1x2|match winner|home win)\b/i.test(text)) marketHint = "h2h";
  else if (/\bplayer\b/i.test(text)) marketHint = "player";

  const ordered: SportId[] = ["football", "basketball", "baseball", "hockey", "tennis", "volleyball", "table-tennis"];
  return {
    raw: text,
    sports: any && !only ? "any" : ordered.filter((sport) => sports.has(sport)),
    count,
    combinedTarget,
    liveOnly: /\blive\b/i.test(text) && !/\blivepool\b/i.test(text),
    window,
    marketHint,
    line,
    side,
    preferEvidence: true,
  };
}

export function zonedParts(date: Date, timeZone = USER_TIMEZONE): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${pick("year")}-${pick("month")}-${pick("day")}`, hour: Number(pick("hour")), minute: Number(pick("minute")) };
}

export function lagosStamp(now = new Date()): { date: string; hour: number } {
  const parts = zonedParts(now);
  return { date: parts.date, hour: parts.hour };
}

function addCalendarDay(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(year!, (month ?? 1) - 1, (day ?? 1) + 1));
  return next.toISOString().slice(0, 10);
}

/** UTC millis of local midnight. Africa/Lagos is UTC+1 and does not use DST. */
export function utcForLocalMidnight(dateStr: string, timeZone = USER_TIMEZONE): number {
  const guess = Date.parse(`${dateStr}T00:00:00Z`);
  const seen = zonedParts(new Date(guess), timeZone);
  const seenAsUtc = Date.parse(
    `${seen.date}T${String(seen.hour).padStart(2, "0")}:${String(seen.minute).padStart(2, "0")}:00Z`,
  );
  const target = Date.parse(`${dateStr}T00:00:00Z`);
  return guess - (seenAsUtc - target);
}

export function localDayRange(window: TimeWindow, now = new Date()): { start: number; end: number; label: string } | null {
  if (window !== "today" && window !== "tomorrow" && window !== "tonight" && window !== "midnight") return null;
  const today = zonedParts(now).date;
  const label = window === "tomorrow" ? addCalendarDay(today) : today;
  const start = utcForLocalMidnight(label);
  const end = utcForLocalMidnight(addCalendarDay(label));
  return { start, end, label };
}

export function eventInWindow(startIso: string | null, state: string, window: TimeWindow, now = new Date()): boolean {
  if (window === "upcoming") {
    if (!startIso) return state !== "post";
    const start = new Date(startIso).getTime();
    if (Number.isNaN(start)) return false;
    const delta = start - now.getTime();
    return state !== "post" && delta < 48 * 3600 * 1000 && delta > -3 * 3600 * 1000;
  }
  const range = localDayRange(window, now);
  if (!range) return false;
  if (state === "in" && window === "today") return true;
  if (!startIso) return false;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return false;
  if (start < range.start || start >= range.end) return false;
  if (window === "tonight") return zonedParts(new Date(start)).hour >= 17 || state === "in";
  if (window === "midnight") return zonedParts(new Date(start)).hour <= 5;
  return true;
}
