import type { LiveSportsProvider, PollPayload, ValidationReport } from "./types.ts";

/**
 * Sportradar / IMG Arena Live Actions.
 * Docs read 2026-10-06:
 *   wss://dde-streams.data.srarena.io/media/soccer/fixtures/{fixtureId}/actions
 * Legacy host wss://dde-streams.data.imgarena.com decommissions 30 Sept 2026.
 * Client sends the token as the first JSON message. Heartbeats every 10 seconds.
 * "A new update any time a key action is completed." No millisecond SLA.
 * REST /actions is post-match only.
 * This adapter does not connect. A token is not a fixture list, and no fixture UUID is invented.
 */

function blocked(): string {
  const hasToken = Boolean(process.env.SPORTRADAR_TOKEN?.trim() || process.env.SPORTRADAR_API_TOKEN?.trim());
  const tokenLine = hasToken
    ? "A token is present in the server environment. It is not logged and it is not used."
    : "No token is set.";
  return [
    "Not connected.",
    "Sportradar Live Actions is a real per-fixture push websocket:",
    "wss://dde-streams.data.srarena.io/media/soccer/fixtures/{fixtureId}/actions.",
    "Docs say the token is the first JSON message, heartbeats are every 10 seconds, and an update is sent when a key action completes.",
    "No millisecond SLA is published. The REST actions endpoint is post-match only.",
    "A token alone is not enough. Fixture UUIDs come from their fixtures API, and that list was not verified as self-serve.",
    "No fixture id is invented here.",
    "Price: UNKNOWN — REQUIRES VERIFICATION.",
    tokenLine,
  ].join(" ");
}

export const sportradarProvider: LiveSportsProvider = {
  capabilities: {
    id: "sportradar",
    label: "Sportradar Live Actions",
    supportsLiveMatches: true,
    supportsGoalEvents: true,
    supportsWebsocket: true,
    supportsSse: false,
    supportsPush: true,
    supportsTimestamps: false,
    transport: "websocket",
    documentedUpdateMs: null,
    pollIntervalMs: null,
    official: true,
    requiresKey: true,
    role: "candidate",
    freeAccess: false,
    trial: false,
    documentedLatency:
      "Docs: an update when a key action is completed, plus a 10-second heartbeat. No millisecond SLA. Not measured against ESPN. Action-packet timestamps: UNKNOWN — REQUIRES VERIFICATION.",
    upstream: "Sportradar / IMG Arena soccer media feed. Venue collection versus scout: UNKNOWN — REQUIRES VERIFICATION.",
    notes:
      "Idle. Per-fixture websocket. REST actions are after the match. Not connected until a contract supplies both a token and a verified fixtures list.",
  },
  configured: () => false,
  disconnectedDetail: () => blocked(),
  async validate(): Promise<ValidationReport> {
    return { ok: false, detail: blocked(), httpStatus: null };
  },
  async poll(): Promise<PollPayload> {
    throw new Error(blocked());
  },
  normalize() {
    return { snapshots: [], malformed: 0 };
  },
};
