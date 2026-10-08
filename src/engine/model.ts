export type RunMode = "live" | "demo";

export type EventType =
  | "MATCH_CREATED"
  | "MATCH_STARTED"
  | "GOAL"
  | "SCORE_CHANGED"
  | "RED_CARD"
  | "YELLOW_CARD"
  | "PENALTY"
  | "SUBSTITUTION"
  | "PERIOD_STARTED"
  | "PERIOD_ENDED"
  | "MATCH_ENDED"
  | "MATCH_STATUS_CHANGED"
  | "PROVISIONAL_GOAL"
  | "CONFIRMED_GOAL"
  | "CANCELLED_GOAL";

export type Certainty = "provisional" | "confirmed" | "cancelled" | "unspecified";

export type CanonicalStatus =
  | "SCHEDULED"
  | "IN_PLAY"
  | "HALFTIME"
  | "FINISHED"
  | "POSTPONED"
  | "CANCELLED"
  | "SUSPENDED"
  | "UNKNOWN";

export type ProviderHealthState =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "DEGRADED"
  | "HEALTHY";

export interface DraftEvent {
  type: EventType;
  certainty: Certainty;
  providerEventId: string | null;
  minute: number | null;
  clock: string | null;
  period: number | null;
  scoreHome: number | null;
  scoreAway: number | null;
  teamSide: "home" | "away" | null;
  player: string | null;
  detail: string | null;
  providerEventTimestamp: string | null;
  /** When the provider says it published the message. Not the kick. Null if absent. */
  providerPublicationTimestamp?: string | null;
  sequence: number | null;
}

export interface ProviderSnapshot {
  provider: string;
  providerMatchId: string;
  home: string;
  away: string;
  homeId: string;
  awayId: string;
  kickoff: string | null;
  competition: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  status: CanonicalStatus;
  rawStatus: string;
  clock: string | null;
  minute: number | null;
  period: number | null;
  /** Provider ordering key. Lower values are older. Null means "not supplied". */
  sequence: number | null;
  events: DraftEvent[];
  /** Set by a push adapter at the moment the line arrived. Poll adapters omit this. */
  receivedAtMs?: number;
  receivedMono?: number;
  /** After that adapter parsed the message. Omitted when it was not measured. */
  parsedAtMs?: number;
}

export interface IngestMeta {
  receivedAtMs: number;
  receivedMono: number;
  /** After JSON.parse. Omitted when the caller did not measure it separately. */
  parsedAtMs?: number;
  mode: RunMode;
}

export interface Observation {
  provider: string;
  receivedAt: string;
  providerEventTimestamp: string | null;
  providerPublicationTimestamp: string | null;
  serverParseTimestamp: string | null;
  serverPublishTimestamp: string | null;
  /** True when this provider's first sight of the match already contained the event. */
  backfill: boolean;
}

export interface PublicEvent {
  eventId: string;
  type: EventType;
  certainty: Certainty;
  provider: string;
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  teamSide: "home" | "away" | null;
  player: string | null;
  clock: string | null;
  minute: number | null;
  period: number | null;
  scoreHome: number | null;
  scoreAway: number | null;
  competition: string | null;
  detail: string | null;
  status: CanonicalStatus;
  backfill: boolean;
  replay: boolean;
  providerEventTimestamp: string | null;
  providerPublicationTimestamp: string | null;
  serverReceiveTimestamp: string;
  serverParseTimestamp: string | null;
  publishedTimestamp: string;
  processingMs: number;
  /** Time from previous poll to this receipt. An upper bound, not the goal instant. */
  detectionUpperBoundMs: number | null;
  /** serverReceive - providerEventTimestamp, only when the provider sent a stamp. */
  providerStampToReceiveMs: number | null;
  inWatchWindow: boolean;
  observations: Observation[];
}

export interface ProviderViewPublic {
  provider: string;
  providerMatchId: string;
  scoreHome: number | null;
  scoreAway: number | null;
  status: CanonicalStatus;
  clock: string | null;
  minute: number | null;
  receivedAt: string;
  sequence: number | null;
}

export interface PublicMatch {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  kickoff: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  status: CanonicalStatus;
  clock: string | null;
  minute: number | null;
  conflict: boolean;
  conflictDetail: string | null;
  providers: string[];
  providerViews: ProviderViewPublic[];
  lastEvent: PublicEvent | null;
  events: PublicEvent[];
}

export interface Quantiles {
  n: number;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface ConflictRecord {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  detail: string;
  at: string;
  providers: string[];
}

export interface PublicProvider {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  health: string;
  detail: string;
  capabilities: Record<string, string | number | boolean | null>;
  failures: number;
  reconnects: number;
  eventsReceived: number;
  eventsMalformed: number;
  lastSuccessAt: string | null;
  validation: string;
}

export interface BoardMetrics {
  received: number;
  processed: number;
  published: number;
  duplicates: number;
  conflicts: number;
  failed: number;
  malformed: number;
  outOfOrder: number;
  processing: Quantiles;
  detectionUpperBound: Quantiles;
  providerStampToReceive: Quantiles;
}

export interface PublicBoard {
  mode: RunMode;
  startedAt: string;
  serverNow: string;
  /** True only when this process attached /ws/live. Otherwise clients use SSE. */
  websocket: boolean;
  matches: PublicMatch[];
  providers: PublicProvider[];
  metrics: BoardMetrics;
  recentConflicts: ConflictRecord[];
  journalCount: number;
  replay: PublicEvent[];
  races: import("./race.ts").SourceRace[];
}

