import type { CanonicalStatus, DraftEvent, ProviderSnapshot } from "../engine/model.ts";
import type { LiveSportsProvider, NormalizeResult } from "./types.ts";
import { readJsonBody } from "./types.ts";

/**
 * Sportmonks Football API v3.
 * Livescores docs (read 2026-10-06): /livescores/latest returns fixtures updated
 * in the last 10 seconds. "Do not poll faster than 10 seconds."
 * "The inplay endpoint is not a WebSocket — it does not push updates."
 * Free plan: Danish Superliga and Scottish Premiership only.
 * Rate limit page: Free 3,000 API calls / entity / hour.
 * Event type ids from docs.sportmonks.com events definition:
 * 14 goal, 15 own goal, 16 penalty, 17 missed penalty, 18 substitution,
 * 19 yellow, 20 red, 21 yellow/red, 10 VAR.
 * VAR + sub_type 1512 is documented as goal disallowed.
 * Score include: description "CURRENT", score.goals, score.participant home|away.
 */
const BASE = "https://api.sportmonks.com/v3/football/livescores/latest";

const GOAL = 14;
const OWN = 15;
const PENALTY = 16;
const MISSED_PENALTY = 17;
const SUB = 18;
const YELLOW = 19;
const RED = 20;
const YELLOW_RED = 21;
const VAR = 10;
const VAR_GOAL_DISALLOWED = 1512;

let token = process.env.SPORTMONKS_TOKEN?.trim() || "";

export function setSportmonksToken(value: string): void {
  token = value.trim();
}

export function sportmonksConfigured(): boolean {
  return token.length > 0;
}

export const sportmonksProvider: LiveSportsProvider = {
  capabilities: {
    id: "sportmonks",
    label: "Sportmonks",
    supportsLiveMatches: true,
    supportsGoalEvents: true,
    supportsWebsocket: false,
    supportsSse: false,
    supportsPush: false,
    supportsTimestamps: false,
    transport: "poll",
    documentedUpdateMs: 10_000,
    pollIntervalMs: 10_000,
    official: true,
    requiresKey: true,
    role: "candidate",
    freeAccess: true,
    trial: false,
    documentedLatency:
      "Their livescores page: /livescores/latest is a 10-second cycle, not a websocket. Do not poll faster than 10 seconds. That cycle is not a measured advantage over ESPN.",
    upstream: "Sportmonks football REST. Scout versus official collection: UNKNOWN — REQUIRES VERIFICATION.",
    notes:
      "REST poll of /livescores/latest every 10s. Free plan is Danish Superliga and Scottish Premiership only. Their own text says the in-play endpoint does not push. A 14-day paid trial was not re-verified on the official pricing page. Token from https://my.sportmonks.com/",
  },
  configured: () => sportmonksConfigured(),
  async validate() {
    if (!token) {
      return { ok: false, detail: "No token. Set SPORTMONKS_TOKEN or submit one in the console.", httpStatus: null };
    }
    const url = `${BASE}?api_token=${encodeURIComponent(token)}&include=scores;participants;events`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const body = (await res.json().catch(() => null)) as { message?: string; data?: unknown } | null;
    if (!res.ok) {
      return { ok: false, detail: body?.message || `HTTP ${res.status}`, httpStatus: res.status };
    }
    const n = Array.isArray(body?.data) ? body.data.length : 0;
    return { ok: true, detail: `Latest livescores reachable (${n} fixtures in this response)`, httpStatus: res.status };
  },
  async poll(fetchImpl) {
    if (!token) throw new Error("Sportmonks token is not set");
    const url = `${BASE}?api_token=${encodeURIComponent(token)}&include=scores;participants;events;state`;
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const body = await readJsonBody(res);
    if (res.status === 429) throw new Error("Sportmonks 429 Too Many Requests");
    if (!res.ok) {
      const message =
        body.raw && typeof body.raw === "object" && "message" in body.raw
          ? String((body.raw as { message: unknown }).message)
          : "";
      throw new Error(message || `Sportmonks HTTP ${res.status}`);
    }
    return { ...body, httpStatus: res.status };
  },
  normalize: normalizeSportmonks,
};

export function normalizeSportmonks(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== "object") return { snapshots: [], malformed: 1 };
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return { snapshots: [], malformed: 1 };
  const snapshots: ProviderSnapshot[] = [];
  let malformed = 0;
  for (const item of data) {
    const snap = one(item);
    if (!snap) malformed += 1;
    else snapshots.push(snap);
  }
  return { snapshots, malformed };
}

function one(item: unknown): ProviderSnapshot | null {
  if (!isObj(item)) return null;
  const participants = Array.isArray(item.participants) ? item.participants.filter(isObj) : [];
  const home = participants.find((p) => locationOf(p) === "home");
  const away = participants.find((p) => locationOf(p) === "away");
  if (!home || !away) return null;
  const homeName = typeof home.name === "string" ? home.name : "";
  const awayName = typeof away.name === "string" ? away.name : "";
  if (!homeName || !awayName) return null;
  const scores = Array.isArray(item.scores) ? item.scores.filter(isObj) : [];
  const current = scores.filter((s) => s.description === "CURRENT");
  const scoreHome = goalsFor(current, "home");
  const scoreAway = goalsFor(current, "away");
  const state = isObj(item.state) ? item.state : {};
  const stateName = String(state.developer_name ?? state.short_name ?? state.name ?? "");
  const events = Array.isArray(item.events) ? item.events.filter(isObj) : [];
  const homeId = String(home.id ?? "");
  const awayId = String(away.id ?? "");
  return {
    provider: "sportmonks",
    providerMatchId: String(item.id ?? ""),
    home: homeName,
    away: awayName,
    homeId,
    awayId,
    kickoff: typeof item.starting_at === "string" ? toUtc(item.starting_at) : null,
    competition: null,
    scoreHome,
    scoreAway,
    status: mapState(stateName),
    rawStatus: stateName || "latest",
    clock: null,
    minute: null,
    period: null,
    sequence: null,
    events: events
      .map((ev) => mapSmEvent(ev, homeId, awayId))
      .filter((e): e is DraftEvent => Boolean(e)),
  };
}

function mapSmEvent(ev: Record<string, unknown>, homeId: string, awayId: string): DraftEvent | null {
  const typeId = typeof ev.type_id === "number" ? ev.type_id : null;
  const sub = typeof ev.sub_type_id === "number" ? ev.sub_type_id : null;
  if (typeId === null) return null;
  let type: DraftEvent["type"] | null = null;
  let certainty: DraftEvent["certainty"] = "unspecified";
  if (typeId === VAR && sub === VAR_GOAL_DISALLOWED) {
    type = "CANCELLED_GOAL";
    certainty = "cancelled";
  } else if (typeId === VAR) {
    return null;
  } else if (typeId === GOAL || typeId === OWN) type = "GOAL";
  else if (typeId === PENALTY) type = "PENALTY";
  else if (typeId === MISSED_PENALTY) type = "PENALTY";
  else if (typeId === YELLOW) type = "YELLOW_CARD";
  else if (typeId === RED || typeId === YELLOW_RED) type = "RED_CARD";
  else if (typeId === SUB) type = "SUBSTITUTION";
  else return null;
  const minute = typeof ev.minute === "number" ? ev.minute : null;
  const extra = typeof ev.extra_minute === "number" ? ev.extra_minute : null;
  const teamId = ev.participant_id != null ? String(ev.participant_id) : ev.team_id != null ? String(ev.team_id) : "";
  const side = teamId && teamId === homeId ? "home" : teamId && teamId === awayId ? "away" : null;
  const parsed = parseResult(ev.result);
  return {
    type,
    certainty,
    providerEventId: ev.id != null ? String(ev.id) : null,
    minute,
    clock: minute == null ? null : extra ? `${minute}+${extra}'` : `${minute}'`,
    period: null,
    scoreHome: parsed?.home ?? null,
    scoreAway: parsed?.away ?? null,
    teamSide: side,
    player: typeof ev.player_name === "string" ? ev.player_name : null,
    detail: typeof ev.info === "string" ? ev.info : typeId === OWN ? "own goal" : null,
    providerEventTimestamp: null,
    sequence: typeof ev.sort_order === "number" ? ev.sort_order : null,
  };
}

function parseResult(result: unknown): { home: number; away: number } | null {
  if (typeof result !== "string") return null;
  const m = result.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

function goalsFor(rows: Record<string, unknown>[], side: "home" | "away"): number | null {
  for (const row of rows) {
    const score = isObj(row.score) ? row.score : null;
    if (!score) continue;
    if (score.participant === side && typeof score.goals === "number") return score.goals;
  }
  return null;
}

function locationOf(participant: Record<string, unknown>): string | null {
  const meta = isObj(participant.meta) ? participant.meta : null;
  if (meta && typeof meta.location === "string") return meta.location;
  return null;
}

function mapState(name: string): CanonicalStatus {
  const n = name.toUpperCase();
  if (!n) return "IN_PLAY";
  if (n.includes("FT") || n.includes("FULL")) return "FINISHED";
  if (n.includes("INPLAY") || n.includes("LIVE") || n.includes("1ST_HALF") && n.includes("IN") || n.includes("2ND")) return "IN_PLAY";
  if (n.includes("HT") || n.includes("HALFTIME")) return "HALFTIME";
  if (n.includes("NS") || n.includes("NOT_START")) return "SCHEDULED";
  if (n.includes("POSTP")) return "POSTPONED";
  if (n.includes("CANCEL") || n.includes("ABAN")) return "CANCELLED";
  if (n.includes("SUSP")) return "SUSPENDED";
  return "UNKNOWN";
}

function toUtc(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("T")) return /z$/i.test(trimmed) ? trimmed : `${trimmed}Z`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) {
    const withT = trimmed.replace(" ", "T");
    return withT.length === 16 ? `${withT}:00Z` : /z$/i.test(withT) ? withT : `${withT}Z`;
  }
  return trimmed;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
