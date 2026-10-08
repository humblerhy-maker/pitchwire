export type Outcome = "pending" | "won" | "lost" | "push" | "void";

export function settleSelection(input: {
  market: "h2h" | "total" | "spread" | string;
  selection: string;
  line: number | null;
  home: string;
  away: string;
  scoreHome: number | null;
  scoreAway: number | null;
  final: boolean;
}): { outcome: Outcome; detail: string } {
  if (!input.final) return { outcome: "pending", detail: "Event is not final in the connected feed." };
  if (input.scoreHome == null || input.scoreAway == null) {
    return { outcome: "pending", detail: "Final score was not in the feed. Outcome was not guessed." };
  }
  if (input.market === "total") {
    if (input.line == null) return { outcome: "void", detail: "Total had no line on the original prediction." };
    const total = input.scoreHome + input.scoreAway;
    if (total === input.line) return { outcome: "push", detail: `Total ${total} equals the line.` };
    const over = input.selection.toLowerCase() === "over";
    const under = input.selection.toLowerCase() === "under";
    if (!over && !under) return { outcome: "void", detail: "Total selection was not over or under." };
    const won = over ? total > input.line : total < input.line;
    return { outcome: won ? "won" : "lost", detail: `Final total ${total} against line ${input.line}.` };
  }
  if (input.market === "h2h") {
    const sel = input.selection.toLowerCase();
    let side: "home" | "away" | "draw" | null = null;
    if (sel === "draw") side = "draw";
    else if (sel === input.home.toLowerCase() || sel === "home") side = "home";
    else if (sel === input.away.toLowerCase() || sel === "away") side = "away";
    if (!side) return { outcome: "void", detail: "Moneyline selection did not match either participant or the draw." };
    const result = input.scoreHome === input.scoreAway ? "draw" : input.scoreHome > input.scoreAway ? "home" : "away";
    return {
      outcome: result === side ? "won" : "lost",
      detail: `Final ${input.scoreHome}-${input.scoreAway}.`,
    };
  }
  if (input.market === "spread") {
    if (input.line == null) return { outcome: "void", detail: "Spread had no line." };
    const isHome = input.selection.toLowerCase() === input.home.toLowerCase();
    const adjusted = isHome
      ? input.scoreHome + input.line - input.scoreAway
      : input.scoreAway + input.line - input.scoreHome;
    if (adjusted === 0) return { outcome: "push", detail: "Spread landed on the line." };
    return { outcome: adjusted > 0 ? "won" : "lost", detail: `Adjusted margin ${adjusted}.` };
  }
  return { outcome: "void", detail: "This market cannot be settled from a final score alone." };
}
