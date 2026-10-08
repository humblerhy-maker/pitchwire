import type { CanonicalStatus, DraftEvent, ProviderSnapshot } from "../engine/model.ts";
import type { LiveSportsProvider, NormalizeResult, PollPayload, ValidationReport } from "./types.ts";
import { readJsonBody } from "./types.ts";

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard";

/**
 * ESPN site scoreboard. Undocumented public JSON used by espn.com.
 * No API key. No SLA. Not a license to redistribute ESPN content.
 * Verified reachable from this environment on 2026-10-06 (HTTP 200, in-play events).
 */
export const espnProvider: LiveSportsProvider = {
  capabilities: {
    id: "espn",
    label: "ESPN baseline (public scoreboard)",
    supportsLiveMatches: true,
    supportsGoalEvents: true,
    supportsWebsocket: false,
    supportsSse: false,
    supportsPush: false,
    supportsTimestamps: false,
    transport: "poll",
    documentedUpdateMs: null,
    pollIntervalMs: 8000,
    official: false,
    requiresKey: false,
    role: "baseline",
    freeAccess: true,
    trial: false,
    documentedLatency:
      "No published update interval and no goal SLA. This adapter looks every 8 seconds. That is how often we ask, not how fast a goal is detected.",
    upstream: "Public ESPN scoreboard. Not a venue feed and not an official developer API.",
    notes:
      "One global soccer scoreboard request discovers every match ESPN is currently publishing. Goal rows are in competitions[].details. No provider event timestamp on that payload. Kept as the baseline public feed.",
  },
  configured: () => true,
  async validate(): Promise<ValidationReport> {
    try {
      const res = await fetch(SCOREBOARD, { headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" } });
      if (!res.ok) return { ok: false, detail: `Scoreboard HTTP ${res.status}`, httpStatus: res.status };
      const body = (await res.json()) as { events?: unknown };
      if (!Array.isArray(body.events)) {
        return { ok: false, detail: "Scoreboard JSON has no events array", httpStatus: res.status };
      }
      return { ok: true, detail: `Scoreboard reachable, ${body.events.length} events in payload`, httpStatus: res.status };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "ESPN request failed", httpStatus: null };
    }
  },
  async poll(fetchImpl): Promise<PollPayload> {
    const res = await fetchImpl(SCOREBOARD, {
      headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    const body = await readJsonBody(res);
    if (!res.ok) {
      throw new Error(`ESPN HTTP ${res.status}`);
    }
    return { ...body, httpStatus: res.status };
  },
  normalize: normalizeEspnScoreboard,
};

export function normalizeEspnScoreboard(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { events?: unknown }).events)) {
    return { snapshots: [], malformed: 1 };
  }
  const snapshots: ProviderSnapshot[] = [];
  let malformed = 0;
  for (const event of (raw as { events: unknown[] }).events) {
    const snap = snapshotFromEspnEvent(event);
    if (!snap) malformed += 1;
    else snapshots.push(snap);
  }
  return { snapshots, malformed };
}

function snapshotFromEspnEvent(event: unknown): ProviderSnapshot | null {
  if (!event || typeof event !== "object") return null;
  const ev = event as Record<string, unknown>;
  const competitions = Array.isArray(ev.competitions) ? ev.competitions : [];
  const comp = competitions[0];
  if (!comp || typeof comp !== "object") return null;
  const c = comp as Record<string, unknown>;
  const competitors = Array.isArray(c.competitors) ? c.competitors : [];
  const home = competitors.find((x) => isObj(x) && x.homeAway === "home");
  const away = competitors.find((x) => isObj(x) && x.homeAway === "away");
  if (!isObj(home) || !isObj(away)) return null;
  const homeTeam = teamOf(home);
  const awayTeam = teamOf(away);
  if (!homeTeam.name || !awayTeam.name) return null;
  const status = isObj(c.status) ? c.status : isObj(ev.status) ? ev.status : {};
  const type = isObj(status.type) ? status.type : {};
  const canonical = mapEspnStatus(String(type.state ?? ""), String(type.name ?? ""));
  const clock = typeof status.displayClock === "string" ? status.displayClock : null;
  const period = typeof status.period === "number" ? status.period : null;
  const minute = clock ? parseMinute(clock) : null;
  const season = isObj(ev.season) ? ev.season : {};
  const competition =
    (typeof c.altGameNote === "string" && c.altGameNote) ||
    (typeof season.slug === "string" ? season.slug : null);
  const kickoff = typeof ev.date === "string" ? ev.date : null;
  const details = Array.isArray(c.details) ? c.details : [];
  const drafts = draftsFromDetails(details, homeTeam.id, awayTeam.id);
  return {
    provider: "espn",
    providerMatchId: String(ev.id ?? c.id ?? ""),
    home: homeTeam.name,
    away: awayTeam.name,
    homeId: homeTeam.id,
    awayId: awayTeam.id,
    kickoff,
    competition,
    scoreHome: numOrNull(home.score),
    scoreAway: numOrNull(away.score),
    status: canonical,
    rawStatus: String(type.name ?? type.state ?? ""),
    clock,
    minute,
    period,
    sequence: null,
    events: drafts,
  };
}

function draftsFromDetails(details: unknown[], homeId: string, awayId: string): DraftEvent[] {
  const goals: { detail: Record<string, unknown>; side: "home" | "away"; clockValue: number }[] = [];
  const other: DraftEvent[] = [];
  for (const item of details) {
    if (!isObj(item)) continue;
    const type = isObj(item.type) ? item.type : {};
    const text = String(type.text ?? "");
    const clock = isObj(item.clock) ? item.clock : {};
    const display = typeof clock.displayValue === "string" ? clock.displayValue : null;
    const clockValue = typeof clock.value === "number" ? clock.value : 0;
    const teamId = isObj(item.team) ? String(item.team.id ?? "") : "";
    const side = teamId && teamId === homeId ? "home" : teamId && teamId === awayId ? "away" : null;
    const player = athleteName(item.athletesInvolved);
    if (item.redCard === true) {
      other.push(draft("RED_CARD", side, display, player, "red card", null, null));
      continue;
    }
    if (item.yellowCard === true && item.scoringPlay !== true) {
      other.push(draft("YELLOW_CARD", side, display, player, text || "yellow card", null, null));
      continue;
    }
    if (item.scoringPlay === true || /goal/i.test(text)) {
      goals.push({ detail: item, side: side ?? "home", clockValue });
      continue;
    }
    if (/substitution/i.test(text)) {
      other.push(draft("SUBSTITUTION", side, display, player, text, null, null));
    }
  }
  goals.sort((a, b) => a.clockValue - b.clockValue);
  let h = 0;
  let a = 0;
  const goalDrafts: DraftEvent[] = goals.map(({ detail, side }) => {
    if (side === "home") h += 1;
    else a += 1;
    const clock = isObj(detail.clock) && typeof detail.clock.displayValue === "string" ? detail.clock.displayValue : null;
    const player = athleteName(detail.athletesInvolved);
    const penalty = detail.penaltyKick === true;
    const own = detail.ownGoal === true;
    return draft(
      penalty ? "PENALTY" : "GOAL",
      side,
      clock,
      player,
      own ? "own goal" : penalty ? "penalty" : null,
      h,
      a,
    );
  });
  return [...goalDrafts, ...other];
}

function draft(
  type: DraftEvent["type"],
  side: "home" | "away" | null,
  clock: string | null,
  player: string | null,
  detail: string | null,
  scoreHome: number | null,
  scoreAway: number | null,
): DraftEvent {
  return {
    type,
    certainty: "unspecified",
    providerEventId: null,
    minute: clock ? parseMinute(clock) : null,
    clock,
    period: null,
    scoreHome,
    scoreAway,
    teamSide: side,
    player,
    detail,
    providerEventTimestamp: null,
    sequence: null,
  };
}

export function mapEspnStatus(state: string, name: string): CanonicalStatus {
  const n = name.toUpperCase();
  if (n.includes("HALFTIME") || n.includes("HALF_TIME")) return "HALFTIME";
  if (n.includes("POSTPON")) return "POSTPONED";
  if (n.includes("CANCEL")) return "CANCELLED";
  if (n.includes("SUSPEND")) return "SUSPENDED";
  if (state === "in") return "IN_PLAY";
  if (state === "post") return "FINISHED";
  if (state === "pre") return "SCHEDULED";
  return "UNKNOWN";
}

function teamOf(competitor: Record<string, unknown>): { id: string; name: string } {
  const team = isObj(competitor.team) ? competitor.team : {};
  const name =
    (typeof team.displayName === "string" && team.displayName) ||
    (typeof team.name === "string" && team.name) ||
    "";
  return { id: String(team.id ?? competitor.id ?? ""), name };
}

function athleteName(list: unknown): string | null {
  if (!Array.isArray(list) || !isObj(list[0])) return null;
  const n = list[0].displayName;
  return typeof n === "string" ? n : null;
}

function parseMinute(clock: string): number | null {
  const m = clock.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
