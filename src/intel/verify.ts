import { canonicalName } from "../engine/ids.ts";

export interface ParsedPick {
  raw: string;
  home: string | null;
  away: string | null;
  selection: string;
  market: "h2h" | "total" | "spread" | "btts" | "corners" | "unknown";
  line: number | null;
  odds: number | null;
}

export function parsePicks(text: string): ParsedPick[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(verify|verification)\b/i.test(line))
    .map(parseLine)
    .filter((pick): pick is ParsedPick => pick !== null);
}

function parseLine(raw: string): ParsedPick | null {
  const cleaned = raw.replace(/^[\d]+[.)]\s*/, "").trim();
  if (!cleaned) return null;
  const oddsMatch = cleaned.match(/@\s*(\d+(?:\.\d+)?)/);
  const odds = oddsMatch ? Number(oddsMatch[1]) : null;
  const body = cleaned.replace(/@\s*\d+(?:\.\d+)?/, "").trim();
  const versus = body.split(/\s+(?:vs\.?|v\.?|—|–|-)\s+/i);
  let home: string | null = null;
  let away: string | null = null;
  let rest = body;
  if (versus.length >= 2 && versus[0] && versus[1]) {
    home = versus[0].trim();
    const right = versus.slice(1).join(" ").trim();
    const cut = right.split(/\s+[—–-]\s+|\s{2,}/);
    away = (cut[0] ?? right).replace(/\b(over|under|btts|draw|home|away|ml|spread).*/i, "").trim() || null;
    rest = cut.slice(1).join(" ") || right.slice((away ?? "").length);
  }
  const lower = `${body} ${rest}`.toLowerCase();
  let market: ParsedPick["market"] = "unknown";
  let selection = rest.trim() || body;
  let line: number | null = null;
  const total = lower.match(/\b(over|under)\s*(\d+(?:\.\d+)?)/i);
  if (total?.[1] && total[2]) {
    market = "total";
    selection = total[1].toLowerCase() === "over" ? "Over" : "Under";
    line = Number(total[2]);
  } else if (/\bbtts|both teams/.test(lower)) {
    market = "btts";
    selection = /no\b/.test(lower) ? "No" : "Yes";
  } else if (/\bcorners?\b/.test(lower)) {
    market = "corners";
    selection = body;
  } else if (/\bdraw\b/.test(lower)) {
    market = "h2h";
    selection = "Draw";
  } else if (/\b(home|away)\b/.test(lower) && /\b(win|ml|moneyline)\b/.test(lower)) {
    market = "h2h";
    selection = /away/.test(lower) ? "Away" : "Home";
  } else if (home && away) {
    market = "unknown";
    selection = rest.trim() || "unspecified";
  }
  if (!home && !away && market === "unknown") return null;
  return { raw, home, away, selection, market, line, odds };
}

export function namesMatch(a: string, b: string): boolean {
  const left = canonicalName(a);
  const right = canonicalName(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}
