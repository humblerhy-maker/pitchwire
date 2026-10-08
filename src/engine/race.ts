import { isGoalLike } from "./ids.ts";
import type { PublicEvent, PublicMatch } from "./model.ts";

/** Pair a suspension with a later baseline goal only inside this window.
 *  It stops a minute-10 suspension being credited for a minute-80 goal.
 *  It is not a latency figure. */
export const PAIRING_WINDOW_MS = 300_000;
export const BASELINE_PROVIDER = "espn";

export type RaceVerdict =
  | "NOT A RACE"
  | "BASELINE HAS NOT REPORTED"
  | "NO OTHER SOURCE"
  | "NO OBSERVED ADVANTAGE"
  | "OBSERVED ADVANTAGE"
  | "UNPAIRED";

export interface SourceRaceRow {
  provider: string;
  receivedAt: string;
  providerEventTimestamp: string | null;
  providerPublicationTimestamp: string | null;
  serverParseTimestamp: string | null;
  serverPublishTimestamp: string | null;
  backfill: boolean;
}

export interface SourceRace {
  id: string;
  method: "same-scoreline" | "suspension-paired";
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  type: string;
  clock: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  rows: SourceRaceRow[];
  fastestProvider: string | null;
  baselineReceivedAt: string | null;
  /** Positive means the fastest non-baseline row was received before ESPN. */
  advantageVsBaselineMs: number | null;
  verdict: RaceVerdict;
  note: string;
}

const GOAL_TYPES = new Set(["GOAL", "PENALTY", "CONFIRMED_GOAL"]);

export function buildSourceRaces(matches: PublicMatch[], nowMs: number): SourceRace[] {
  const races: SourceRace[] = [];
  for (const match of matches) {
    for (const event of match.events) {
      if (event.replay || event.type === "PROVISIONAL_GOAL" || event.type === "CANCELLED_GOAL") continue;
      if (!isGoalLike(event.type) && event.type !== "SCORE_CHANGED") continue;
      if (event.type === "SCORE_CHANGED") {
        const covered = match.events.some(
          (other) =>
            GOAL_TYPES.has(other.type) &&
            other.scoreHome === event.scoreHome &&
            other.scoreAway === event.scoreAway,
        );
        if (covered) continue;
      }
      const race = scorelineRace(event);
      if (race.verdict === "NOT A RACE") continue;
      races.push(race);
    }
    races.push(...pairSuspensions(match, nowMs));
  }
  races.sort((a, b) => {
    const at = a.rows.find((row) => !row.backfill)?.receivedAt ?? "";
    const bt = b.rows.find((row) => !row.backfill)?.receivedAt ?? "";
    return bt.localeCompare(at);
  });
  return races.slice(0, 40);
}

function scorelineRace(event: PublicEvent): SourceRace {
  const rows = event.observations.map(toRow);
  const live = rows.filter((row) => !row.backfill);
  const base = describe(event, "same-scoreline", rows);
  if (live.length === 0) {
    return { ...base, verdict: "NOT A RACE", note: "Already on the feed when that provider was first seen. Not a latency measurement." };
  }
  const baseline = live.find((row) => row.provider === BASELINE_PROVIDER) ?? null;
  const fastest = earliest(live);
  if (!baseline && live.length > 0) {
    return {
      ...base,
      fastestProvider: fastest?.provider ?? null,
      verdict: "BASELINE HAS NOT REPORTED",
      note: "Another source has this scoreline. ESPN has not reported it while we were watching. No advantage is claimed yet.",
    };
  }
  if (baseline && live.length === 1) {
    return {
      ...base,
      fastestProvider: BASELINE_PROVIDER,
      baselineReceivedAt: baseline.receivedAt,
      advantageVsBaselineMs: 0,
      verdict: "NO OTHER SOURCE",
      note: "Only the ESPN baseline has reported this while we were watching.",
    };
  }
  if (!baseline || !fastest) {
    return { ...base, verdict: "NOT A RACE", note: "Not enough watched observations." };
  }
  const advantage = Date.parse(baseline.receivedAt) - Date.parse(fastest.receivedAt);
  if (!Number.isFinite(advantage)) {
    return { ...base, verdict: "NOT A RACE", note: "A receipt timestamp could not be parsed." };
  }
  if (advantage <= 0) {
    return {
      ...base,
      fastestProvider: fastest.provider,
      baselineReceivedAt: baseline.receivedAt,
      advantageVsBaselineMs: advantage,
      verdict: "NO OBSERVED ADVANTAGE",
      note: "On this event the ESPN baseline was received first or at the same millisecond. Not a standing ranking.",
    };
  }
  return {
    ...base,
    fastestProvider: fastest.provider,
    baselineReceivedAt: baseline.receivedAt,
    advantageVsBaselineMs: advantage,
    verdict: "OBSERVED ADVANTAGE",
    note: `${fastest.provider} was received before ESPN on this event only. Not a claim that it is always faster.`,
  };
}

function pairSuspensions(match: PublicMatch, nowMs: number): SourceRace[] {
  const suspensions = match.events.filter(
    (event) => event.type === "PROVISIONAL_GOAL" && event.provider === "betfair" && !event.replay,
  );
  const goals = match.events.filter(
    (event) => GOAL_TYPES.has(event.type) && event.provider === BASELINE_PROVIDER && !event.replay,
  );
  const used = new Set<string>();
  const races: SourceRace[] = [];
  const ordered = [...suspensions].sort((a, b) => timeOf(a, "betfair") - timeOf(b, "betfair"));
  for (const suspension of ordered) {
    const susAt = timeOf(suspension, "betfair");
    const susRow = suspension.observations.find((row) => row.provider === "betfair");
    if (!susRow || susRow.backfill || !Number.isFinite(susAt)) continue;
    const goal = goals
      .filter((event) => !used.has(event.eventId))
      .map((event) => ({ event, at: timeOf(event, BASELINE_PROVIDER) }))
      .filter((item) => Number.isFinite(item.at) && item.at >= susAt && item.at - susAt <= PAIRING_WINDOW_MS)
      .sort((a, b) => a.at - b.at)[0];
    const rows: SourceRaceRow[] = [toRow(susRow)];
    if (!goal) {
      const waiting = nowMs - susAt <= PAIRING_WINDOW_MS;
      races.push({
        id: `pair_${suspension.eventId}`,
        method: "suspension-paired",
        matchId: match.matchId,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        type: "PROVISIONAL_GOAL",
        clock: suspension.clock,
        scoreHome: null,
        scoreAway: null,
        rows,
        fastestProvider: waiting ? null : "betfair",
        baselineReceivedAt: null,
        advantageVsBaselineMs: null,
        verdict: waiting ? "BASELINE HAS NOT REPORTED" : "UNPAIRED",
        note: waiting
          ? "Betfair suspended a match-odds market with reason Goal. ESPN has not reported a goal on this match yet. No advantage is claimed."
          : `No ESPN goal landed within ${PAIRING_WINDOW_MS / 1000}s. Left unpaired. Not counted as an advantage.`,
      });
      continue;
    }
    used.add(goal.event.eventId);
    const espnRow = goal.event.observations.find((row) => row.provider === BASELINE_PROVIDER && !row.backfill);
    if (!espnRow) continue;
    rows.push(toRow(espnRow));
    const advantage = goal.at - susAt;
    races.push({
      id: `pair_${suspension.eventId}`,
      method: "suspension-paired",
      matchId: match.matchId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      type: "PROVISIONAL_GOAL",
      clock: goal.event.clock,
      scoreHome: goal.event.scoreHome,
      scoreAway: goal.event.scoreAway,
      rows,
      fastestProvider: advantage > 0 ? "betfair" : BASELINE_PROVIDER,
      baselineReceivedAt: espnRow.receivedAt,
      advantageVsBaselineMs: advantage,
      verdict: advantage > 0 ? "OBSERVED ADVANTAGE" : "NO OBSERVED ADVANTAGE",
      note:
        advantage > 0
          ? "Paired because both refer to the same match and the ESPN goal receipt fell inside the pairing window. Betfair did not send a score. This is one event, not a ranking."
          : "The ESPN goal was not later than the suspension.",
    });
  }
  return races;
}

function describe(event: PublicEvent, method: SourceRace["method"], rows: SourceRaceRow[]): SourceRace {
  return {
    id: event.eventId,
    method,
    matchId: event.matchId,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    type: event.type,
    clock: event.clock,
    scoreHome: event.scoreHome,
    scoreAway: event.scoreAway,
    rows,
    fastestProvider: null,
    baselineReceivedAt: null,
    advantageVsBaselineMs: null,
    verdict: "NOT A RACE",
    note: "",
  };
}

function toRow(row: PublicEvent["observations"][number]): SourceRaceRow {
  return {
    provider: row.provider,
    receivedAt: row.receivedAt,
    providerEventTimestamp: row.providerEventTimestamp,
    providerPublicationTimestamp: row.providerPublicationTimestamp,
    serverParseTimestamp: row.serverParseTimestamp,
    serverPublishTimestamp: row.serverPublishTimestamp,
    backfill: row.backfill,
  };
}

function earliest(rows: SourceRaceRow[]): SourceRaceRow | null {
  return [...rows].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))[0] ?? null;
}

function timeOf(event: PublicEvent, provider: string): number {
  const row = event.observations.find((item) => item.provider === provider && !item.backfill);
  if (!row) return Number.NaN;
  return Date.parse(row.receivedAt);
}
