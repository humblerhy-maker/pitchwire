import type { DraftEvent, ProviderSnapshot } from "../engine/model.ts";
import type { LiveSportsProvider, NormalizeResult } from "./types.ts";

/**
 * Deterministic demo timeline. Fictional clubs only.
 * Never used while the engine is in live mode (the engine drops provider "demo").
 */
const KICKOFF = "2026-01-01T18:00:00.000Z";

interface Step {
  atMs: number;
  status: ProviderSnapshot["status"];
  scoreHome: number;
  scoreAway: number;
  clock: string;
  minute: number;
  period: number;
  event?: DraftEvent;
}

const STEPS: Step[] = [
  { atMs: 0, status: "SCHEDULED", scoreHome: 0, scoreAway: 0, clock: "0'", minute: 0, period: 1 },
  { atMs: 1000, status: "IN_PLAY", scoreHome: 0, scoreAway: 0, clock: "1'", minute: 1, period: 1 },
  {
    atMs: 4000,
    status: "IN_PLAY",
    scoreHome: 1,
    scoreAway: 0,
    clock: "12'",
    minute: 12,
    period: 1,
    event: goal("demo-g1", "home", "A. Okonkwo", 12, 1, 0, "12'"),
  },
  { atMs: 8000, status: "HALFTIME", scoreHome: 1, scoreAway: 0, clock: "HT", minute: 45, period: 1 },
  { atMs: 11000, status: "IN_PLAY", scoreHome: 1, scoreAway: 0, clock: "46'", minute: 46, period: 2 },
  {
    atMs: 15000,
    status: "IN_PLAY",
    scoreHome: 1,
    scoreAway: 1,
    clock: "67'",
    minute: 67,
    period: 2,
    event: goal("demo-g2", "away", "M. Berger", 67, 1, 1, "67'"),
  },
  {
    atMs: 19000,
    status: "IN_PLAY",
    scoreHome: 1,
    scoreAway: 1,
    clock: "71'",
    minute: 71,
    period: 2,
    event: {
      type: "YELLOW_CARD",
      certainty: "unspecified",
      providerEventId: "demo-yc1",
      minute: 71,
      clock: "71'",
      period: 2,
      scoreHome: 1,
      scoreAway: 1,
      teamSide: "home",
      player: "L. Mensah",
      detail: "demo card",
      providerEventTimestamp: null,
      sequence: 71,
    },
  },
  { atMs: 23000, status: "FINISHED", scoreHome: 1, scoreAway: 1, clock: "FT", minute: 90, period: 2 },
];

function goal(
  id: string,
  side: "home" | "away",
  player: string,
  minute: number,
  scoreHome: number,
  scoreAway: number,
  clock: string,
): DraftEvent {
  return {
    type: "GOAL",
    certainty: "unspecified",
    providerEventId: id,
    minute,
    clock,
    period: minute > 45 ? 2 : 1,
    scoreHome,
    scoreAway,
    teamSide: side,
    player,
    detail: "demo",
    providerEventTimestamp: null,
    sequence: minute,
  };
}

export function demoSnapshot(elapsedMs: number): ProviderSnapshot {
  let step = STEPS[0]!;
  for (const candidate of STEPS) {
    if (elapsedMs >= candidate.atMs) step = candidate;
  }
  return {
    provider: "demo",
    providerMatchId: "demo-match-1",
    home: "Harbour FC",
    away: "Northbridge",
    homeId: "harbour",
    awayId: "northbridge",
    kickoff: KICKOFF,
    competition: "Demo Cup",
    scoreHome: step.scoreHome,
    scoreAway: step.scoreAway,
    status: step.status,
    rawStatus: step.status,
    clock: step.clock,
    minute: step.minute,
    period: step.period,
    sequence: step.atMs,
    events: step.event ? [step.event] : [],
  };
}

export const demoProvider: LiveSportsProvider = {
  capabilities: {
    id: "demo",
    label: "Demo generator",
    supportsLiveMatches: false,
    supportsGoalEvents: true,
    supportsWebsocket: false,
    supportsSse: false,
    supportsPush: false,
    supportsTimestamps: false,
    transport: "poll",
    documentedUpdateMs: null,
    pollIntervalMs: 1000,
    official: false,
    requiresKey: false,
    role: "demo",
    freeAccess: true,
    trial: false,
    documentedLatency: "Not a data source. A fictional script. Never used as a latency measurement.",
    upstream: "Local generator. Disabled in live mode.",
    notes: "Deterministic fictional match. Disabled entirely in LIVE mode.",
  },
  configured: () => true,
  async validate() {
    return { ok: true, detail: "Local deterministic script. No network.", httpStatus: null };
  },
  async poll() {
    return { raw: { elapsed: 0 }, httpStatus: 200, receivedAtMs: Date.now(), receivedMono: performance.now() };
  },
  normalize(): NormalizeResult {
    return { snapshots: [], malformed: 0 };
  },
};
