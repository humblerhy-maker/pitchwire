import { noVig, round4 } from "./odds-math.ts";
import type { Quote } from "./quotes.ts";

export interface RecordRate {
  wins: number;
  losses: number;
  other: number;
  games: number;
  winRate: number;
}

export interface Decision {
  /** Eligible means the quote is real enough to send to a model. It is not a prediction. */
  decision: "eligible" | "withheld";
  confidence: "not-issued" | "supported";
  reasons: string[];
  gaps: string[];
  checks: string[];
  modelProbability: number | null;
  modelLabel: string | null;
  noVig: number | null;
}

export function parseRecord(summary: string | null): RecordRate | null {
  if (!summary) return null;
  const parts = summary.split("-").map((part) => Number(part));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const wins = parts[0] ?? 0;
  const losses = parts[1] ?? 0;
  const other = parts.slice(2).reduce((sum, n) => sum + n, 0);
  const games = wins + losses + other;
  if (games <= 0) return null;
  return { wins, losses, other, games, winRate: wins / games };
}

export function decide(input: {
  sport: string;
  quote: Quote;
  sameMarketImplied: number[];
  selectionIndex: number;
  recordA: string | null;
  recordB: string | null;
  marketHint: string | null;
  feeds: { injuries: boolean; oneXBet: boolean; scoringRates: boolean; pitcherKnown?: boolean };
  pitcherNote?: string | null;
}): Decision {
  const checks: string[] = [];
  const gaps: string[] = [];
  const reasons: string[] = [];
  checks.push(
    `Price is an observed ${input.quote.bookmaker} ${input.quote.market} of ${input.quote.decimal.toFixed(2)} from ${input.quote.source}.`,
  );
  if (input.quote.decimal < 1.4) {
    checks.push("Short price was not treated as safety. Low odds are not evidence.");
  }
  if (input.quote.openDecimal != null && input.quote.openDecimal !== input.quote.decimal) {
    checks.push(
      `Open ${input.quote.openDecimal.toFixed(2)} to close ${input.quote.decimal.toFixed(2)} is movement, not a pick.`,
    );
  }
  const fair = noVig(input.sameMarketImplied, input.selectionIndex);
  if (fair != null) checks.push(`No-vig share of this price inside its market is ${(fair * 100).toFixed(1)}%. That still is not a true probability.`);

  if (input.marketHint && !hintMatches(input.marketHint, input.quote.market)) {
    gaps.push(`The request asked for ${input.marketHint}. This quote is ${input.quote.market}.`);
  }
  if (!input.feeds.injuries) {
    gaps.push("Team news is incomplete on the public feeds. That is uncertainty, not a fabricated injury list.");
  }
  if (input.sport === "baseball") {
    if (input.feeds.pitcherKnown && input.pitcherNote) checks.push(input.pitcherNote);
    else gaps.push("Probable pitcher was not in this payload.");
  }
  if (input.sport === "basketball" || input.sport === "hockey") {
    gaps.push("Rest, rotation, and pace were not in this payload.");
  }
  if (
    (input.sport === "football" && input.quote.market === "total" && !input.feeds.scoringRates) ||
    input.marketHint === "btts" ||
    input.marketHint === "corners"
  ) {
    gaps.push("The rate this market needs was not in the public feeds. The market was not invented.");
  }
  if (input.marketHint === "player") {
    gaps.push("Player markets were not in the public scoreboard.");
  }

  const a = parseRecord(input.recordA);
  const b = parseRecord(input.recordB);
  let modelProbability: number | null = null;
  let modelLabel: string | null = null;
  if (input.quote.market === "h2h" && input.quote.selection !== "Draw" && a && b) {
    checks.push(`Observed records ${input.recordA} and ${input.recordB}.`);
    if (a.games < 20 || b.games < 20) {
      gaps.push(`Season sample is ${a.games} and ${b.games} decided-or-recorded games. Too thin to use as a rate.`);
    } else {
      const share = a.winRate / (a.winRate + b.winRate);
      modelProbability = round4(share);
      modelLabel = "Ratio of season win rates. Not a match model and not used as a selection by itself.";
      if (fair != null && Math.abs(share - fair) >= 0.08) {
        reasons.push(
          "The weak win-rate ratio and the no-vig price differ by at least 8 points. That disagreement is a reason to keep looking, not a reason to bet.",
        );
      } else if (fair != null) {
        checks.push("Win-rate ratio and no-vig price are close. Agreement of two weak signals is not enough.");
      }
    }
  } else if (input.quote.market !== "h2h") {
    gaps.push("No sport-specific rate for this market was present, so no total or spread model was run.");
  }

  const hard =
    (input.marketHint != null && !hintMatches(input.marketHint, input.quote.market)) ||
    input.marketHint === "btts" ||
    input.marketHint === "corners" ||
    input.marketHint === "player";
  if (hard) reasons.push("Not eligible. The requested market is not on the public feeds, so it was not guessed.");
  else reasons.push("Eligible for a model. This is not a prediction until a configured model returns this id.");
  return {
    decision: hard ? "withheld" : "eligible",
    confidence: "not-issued",
    reasons,
    gaps,
    checks,
    modelProbability,
    modelLabel,
    noVig: fair == null ? null : round4(fair),
  };
}

function hintMatches(hint: string, market: Quote["market"]): boolean {
  if (hint === "total") return market === "total";
  if (hint === "spread") return market === "spread";
  if (hint === "h2h") return market === "h2h";
  if (hint === "btts" || hint === "corners" || hint === "player") return false;
  return true;
}

export interface SlipLeg {
  id: string;
  decimal: number;
  issued: boolean;
}

/** Uses issued legs only. Never pads with withheld prices to hit a target. Unpriced issued legs stay; their price is not invented. */
export function buildSlip(legs: SlipLeg[], target: number | null, count: number | null): {
  ids: string[];
  combined: number | null;
  note: string;
} {
  const issuedAll = legs.filter((leg) => leg.issued);
  const priced = issuedAll.filter((leg) => leg.decimal > 1);
  if (issuedAll.length === 0) {
    return {
      ids: [],
      combined: null,
      note: "No selection was issued. Weak or unverified prices were not added to manufacture a total.",
    };
  }
  if (target == null) {
    const take = count != null ? issuedAll.slice(0, count) : issuedAll;
    const allPriced = take.every((leg) => leg.decimal > 1);
    const combined = allPriced ? roundProduct(take.map((leg) => leg.decimal)) : null;
    const short = count != null && issuedAll.length < count;
    return {
      ids: take.map((leg) => leg.id),
      combined,
      note: short
        ? `Only ${issuedAll.length} selection(s) cleared the evidence bar. The requested count was not filled.`
        : allPriced
          ? "Combined price uses issued selections only."
          : "Issued from the evidence screen. A public price was missing on at least one leg, so no combined price was calculated and none was invented.",
    };
  }
  if (priced.length === 0) {
    return {
      ids: [],
      combined: null,
      note: "Issued selections had no public price, so a combined total was not invented.",
    };
  }
  const ranked = priced;
  const take = count != null ? ranked.slice(0, count) : ranked;
  if (count != null && ranked.length < count) {
    const combined = roundProduct(take.map((leg) => leg.decimal));
    return {
      ids: take.map((leg) => leg.id),
      combined,
      note: `Only ${ranked.length} issued selection(s). The requested count was not filled with withheld legs.`,
    };
  }
  let best: SlipLeg[] = [];
  let bestDistance = Number.POSITIVE_INFINITY;
  const limit = Math.min(take.length, 6);
  const pool = take.slice(0, limit);
  const n = pool.length;
  const maxMask = 1 << n;
  for (let mask = 1; mask < maxMask; mask += 1) {
    const chosen: SlipLeg[] = [];
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) chosen.push(pool[i]!);
    if (count != null && chosen.length !== count) continue;
    const combined = chosen.reduce((acc, leg) => acc * leg.decimal, 1);
    const distance = Math.abs(combined - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = chosen;
    }
  }
  if (best.length === 0) {
    return {
      ids: [],
      combined: null,
      note: "Issued selections could not be arranged into the requested count. Nothing else was added.",
    };
  }
  const combined = roundProduct(best.map((leg) => leg.decimal));
  const near = combined != null && Math.abs(combined - target) <= target * 0.15;
  return {
    ids: best.map((leg) => leg.id),
    combined,
    note: near
      ? "Combined price is from issued selections only and is near the request."
      : "This is as close as the issued selections get. The target was not forced.",
  };
}

function roundProduct(decimals: number[]): number | null {
  if (decimals.length === 0) return null;
  const value = decimals.reduce((acc, n) => acc * n, 1);
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}
