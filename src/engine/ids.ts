import type { EventType } from "./model.ts";

export function canonicalName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(fc|cf|sc|afc|club)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** FNV-1a 32-bit. Stable across processes. Not a security hash. */
export function hashId(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function canonicalMatchId(
  home: string,
  away: string,
  kickoff: string | null,
): string {
  const bucket = kickoff ? kickoff.slice(0, 13) : "na";
  return `m_${hashId(`${canonicalName(home)}|${canonicalName(away)}|${bucket}`)}`;
}

export function providerFingerprint(input: {
  provider: string;
  matchId: string;
  type: EventType;
  providerEventId: string | null;
  clock: string | null;
  teamSide: "home" | "away" | null;
  player: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
}): string {
  if (input.providerEventId) {
    return `${input.provider}:id:${input.providerEventId}`;
  }
  return [
    input.provider,
    "fp",
    input.matchId,
    input.type,
    input.clock ?? "",
    input.teamSide ?? "",
    canonicalName(input.player ?? ""),
    input.scoreHome ?? "",
    input.scoreAway ?? "",
  ].join(":");
}

/** Same scoreline goal reported by another provider. */
export function crossGoalKey(
  matchId: string,
  scoreHome: number | null,
  scoreAway: number | null,
): string {
  return `${matchId}:goal-score:${scoreHome ?? "x"}-${scoreAway ?? "x"}`;
}

export function isGoalLike(type: EventType): boolean {
  return (
    type === "GOAL" ||
    type === "PENALTY" ||
    type === "PROVISIONAL_GOAL" ||
    type === "CONFIRMED_GOAL" ||
    type === "CANCELLED_GOAL"
  );
}

/**
 * Exponential backoff with jitter.
 * `rand` is in [0, 1). Cap 60s. Base 500ms.
 */
export function backoffMs(attempt: number, rand: number): number {
  const n = Math.max(0, attempt);
  const exp = Math.min(60_000, 500 * 2 ** Math.min(n, 16));
  const clamped = Math.min(0.999, Math.max(0, rand));
  const jitter = 0.5 + clamped * 0.5;
  return Math.round(exp * jitter);
}
