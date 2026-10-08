import type { CanonicalStatus, DraftEvent, ProviderSnapshot } from "../engine/model.ts";
import type { LiveSportsProvider, NormalizeResult } from "./types.ts";
import { readJsonBody } from "./types.ts";

/**
 * API-Football v3 (api-sports).
 * Base https://v3.football.api-sports.io verified by a live request.
 * Auth header name is advertised by the API's own CORS allow-headers: x-apisports-key.
 * Docs (mirrored, read 2026-10-06): fixtures update every 15 seconds, with possible extra delay.
 * Free plan on the pricing page: 100 requests/day. That cannot sustain a 15s poll for 24h.
 * Event type/detail vocabulary from the fixtures/events section of that doc:
 * Goal (Normal Goal, Own Goal, Penalty, Missed Penalty), Card (Yellow Card, Red card),
 * Subst, Var (Goal cancelled, Penalty confirmed).
 * Nested event fields time/team/player/type/detail are parsed defensively.
 */
const BASE = "https://v3.football.api-sports.io";

let apiKey = process.env.APIFOOTBALL_KEY?.trim() || process.env.SPORTS_PROVIDER_API_KEY?.trim() || "";

export function setApiFootballKey(key: string): void {
  apiKey = key.trim();
}

export function apiFootballConfigured(): boolean {
  return apiKey.length > 0;
}

export const apiFootballProvider: LiveSportsProvider = {
  capabilities: {
    id: "api-football",
    label: "API-Football",
    supportsLiveMatches: true,
    supportsGoalEvents: true,
    supportsWebsocket: false,
    supportsSse: false,
    supportsPush: false,
    supportsTimestamps: false,
    transport: "poll",
    documentedUpdateMs: 15_000,
    pollIntervalMs: 15_000,
    official: true,
    requiresKey: true,
    role: "candidate",
    freeAccess: true,
    trial: false,
    documentedLatency:
      "Their fixtures text: updated every 15 seconds, with a possible extra delay. Not a push feed. Not claimed earlier than the ESPN baseline.",
    upstream: "API-Football REST. Who collects the event before that 15-second cycle: UNKNOWN — REQUIRES VERIFICATION.",
    notes:
      "Official REST. Free tier is 100 requests/day, which cannot hold a 15-second poll. No WebSocket in the documentation we could read. Register at https://www.api-football.com/pricing",
  },
  configured: () => apiFootballConfigured(),
  async validate() {
    if (!apiKey) {
      return {
        ok: false,
        detail: "No API key. Set APIFOOTBALL_KEY or submit one in the console. It stays in server memory only.",
        httpStatus: null,
      };
    }
    const res = await fetch(`${BASE}/status`, { headers: headers() });
    const body = (await res.json().catch(() => null)) as { errors?: unknown; response?: unknown } | null;
    const errors = body && body.errors && !isEmptyErrors(body.errors) ? JSON.stringify(body.errors) : "";
    if (!res.ok || errors) {
      return { ok: false, detail: errors || `HTTP ${res.status}`, httpStatus: res.status };
    }
    return { ok: true, detail: "Status endpoint accepted the key", httpStatus: res.status };
  },
  async poll(fetchImpl) {
    if (!apiKey) throw new Error("API-Football key is not set");
    const res = await fetchImpl(`${BASE}/fixtures?live=all`, { headers: headers(), signal: AbortSignal.timeout(8000) });
    const body = await readJsonBody(res);
    if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
    const errors = body.raw && typeof body.raw === "object" ? (body.raw as { errors?: unknown }).errors : null;
    if (errors && !isEmptyErrors(errors)) {
      throw new Error(`API-Football errors: ${JSON.stringify(errors)}`);
    }
    return { ...body, httpStatus: res.status };
  },
  normalize: normalizeApiFootball,
};

function headers(): Record<string, string> {
  return { "x-apisports-key": apiKey, accept: "application/json" };
}

export function normalizeApiFootball(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== "object") return { snapshots: [], malformed: 1 };
  const response = (raw as { response?: unknown }).response;
  if (!Array.isArray(response)) return { snapshots: [], malformed: 1 };
  const snapshots: ProviderSnapshot[] = [];
  let malformed = 0;
  for (const item of response) {
    const snap = one(item);
    if (!snap) malformed += 1;
    else snapshots.push(snap);
  }
  return { snapshots, malformed };
}

function one(item: unknown): ProviderSnapshot | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const fixture = isObj(row.fixture) ? row.fixture : null;
  const teams = isObj(row.teams) ? row.teams : null;
  const home = teams && isObj(teams.home) ? teams.home : null;
  const away = teams && isObj(teams.away) ? teams.away : null;
  if (!fixture || !home || !away) return null;
  const homeName = typeof home.name === "string" ? home.name : "";
  const awayName = typeof away.name === "string" ? away.name : "";
  if (!homeName || !awayName) return null;
  const status = isObj(fixture.status) ? fixture.status : {};
  const short = typeof status.short === "string" ? status.short : "";
  const goals = isObj(row.goals) ? row.goals : {};
  const league = isObj(row.league) ? row.league : {};
  const elapsed = typeof status.elapsed === "number" ? status.elapsed : null;
  const events = Array.isArray(row.events) ? row.events : [];
  return {
    provider: "api-football",
    providerMatchId: String(fixture.id ?? ""),
    home: homeName,
    away: awayName,
    homeId: String(home.id ?? homeName),
    awayId: String(away.id ?? awayName),
    kickoff: typeof fixture.date === "string" ? fixture.date : null,
    competition: typeof league.name === "string" ? league.name : null,
    scoreHome: num(goals.home),
    scoreAway: num(goals.away),
    status: mapShort(short),
    rawStatus: short,
    clock: elapsed != null ? `${elapsed}'` : short || null,
    minute: elapsed,
    period: short === "1H" ? 1 : short === "2H" ? 2 : short === "ET" ? 3 : null,
    sequence: typeof fixture.timestamp === "number" ? fixture.timestamp : null,
    events: events.map((ev) => eventFrom(ev, String(home.id ?? ""), String(away.id ?? ""))).filter((e): e is DraftEvent => Boolean(e)),
  };
}

function eventFrom(ev: unknown, homeId: string, awayId: string): DraftEvent | null {
  if (!isObj(ev)) return null;
  const type = typeof ev.type === "string" ? ev.type : "";
  const detail = typeof ev.detail === "string" ? ev.detail : "";
  const time = isObj(ev.time) ? ev.time : {};
  const elapsed = typeof time.elapsed === "number" ? time.elapsed : null;
  const extra = typeof time.extra === "number" ? time.extra : null;
  const team = isObj(ev.team) ? ev.team : {};
  const teamId = team.id != null ? String(team.id) : "";
  const side = teamId && teamId === homeId ? "home" : teamId && teamId === awayId ? "away" : null;
  const player = isObj(ev.player) && typeof ev.player.name === "string" ? ev.player.name : null;
  const mapped = mapEvent(type, detail);
  if (!mapped) return null;
  const clock = elapsed == null ? null : extra ? `${elapsed}+${extra}'` : `${elapsed}'`;
  return {
    type: mapped.type,
    certainty: mapped.certainty,
    providerEventId: null,
    minute: elapsed,
    clock,
    period: null,
    scoreHome: null,
    scoreAway: null,
    teamSide: side,
    player,
    detail: detail || null,
    providerEventTimestamp: null,
    sequence: null,
  };
}

function mapEvent(type: string, detail: string): { type: DraftEvent["type"]; certainty: DraftEvent["certainty"] } | null {
  const t = type.toLowerCase();
  const d = detail.toLowerCase();
  if (t === "var" && d.includes("cancel")) return { type: "CANCELLED_GOAL", certainty: "cancelled" };
  if (t === "goal" && d.includes("missed")) return { type: "PENALTY", certainty: "unspecified" };
  if (t === "goal" && d.includes("penalty")) return { type: "PENALTY", certainty: "unspecified" };
  if (t === "goal") return { type: "GOAL", certainty: "unspecified" };
  if (t === "card" && d.includes("red")) return { type: "RED_CARD", certainty: "unspecified" };
  if (t === "card") return { type: "YELLOW_CARD", certainty: "unspecified" };
  if (t === "subst") return { type: "SUBSTITUTION", certainty: "unspecified" };
  return null;
}

export function mapShort(short: string): CanonicalStatus {
  switch (short) {
    case "TBD":
    case "NS":
      return "SCHEDULED";
    case "1H":
    case "2H":
    case "ET":
    case "BT":
    case "P":
    case "LIVE":
    case "INT":
      return "IN_PLAY";
    case "SUSP":
      return "SUSPENDED";
    case "HT":
      return "HALFTIME";
    case "FT":
    case "AET":
    case "PEN":
      return "FINISHED";
    case "PST":
      return "POSTPONED";
    case "CANC":
    case "ABD":
    case "AWD":
    case "WO":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

function isEmptyErrors(errors: unknown): boolean {
  if (Array.isArray(errors)) return errors.length === 0;
  if (errors && typeof errors === "object") return Object.keys(errors).length === 0;
  return !errors;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
