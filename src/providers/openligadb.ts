import type { CanonicalStatus, DraftEvent, ProviderSnapshot } from "../engine/model.ts";
import type { LiveSportsProvider, NormalizeResult } from "./types.ts";
import { readJsonBody } from "./types.ts";

/**
 * OpenLigaDB. Official community API, no key, ODbL 1.0.
 * Documented limit: 60 requests / minute / IP.
 * https://api.openligadb.de/swagger/v1/swagger.json
 * Goals are match.goals[] (goalID, scoreTeam1, scoreTeam2, matchMinute, goalGetterName, isPenalty, isOwnGoal).
 * There is no goal wall-clock in the Goal schema. Latency is whenever a community editor saves.
 */
const LEAGUES = ["bl1", "bl2", "bl3", "dfb", "ucl"] as const;

export const openLigaProvider: LiveSportsProvider = {
  capabilities: {
    id: "openligadb",
    label: "OpenLigaDB (reference)",
    supportsLiveMatches: true,
    supportsGoalEvents: true,
    supportsWebsocket: false,
    supportsSse: false,
    supportsPush: false,
    supportsTimestamps: false,
    transport: "poll",
    documentedUpdateMs: null,
    pollIntervalMs: 30_000,
    official: true,
    requiresKey: false,
    role: "reference",
    freeAccess: true,
    trial: false,
    documentedLatency:
      "No published goal latency. Updates when a community editor saves. This adapter polls every 30 seconds.",
    upstream: "OpenLigaDB community match data under ODbL. Not a scout feed.",
    notes:
      "Free, no key, ODbL. Polls current matchday for bl1, bl2, bl3, dfb, ucl. Goal records have matchMinute but no event timestamp.",
  },
  configured: () => true,
  async validate() {
    try {
      const res = await fetch("https://api.openligadb.de/getmatchdata/bl1", { headers: { accept: "application/json" } });
      if (!res.ok) return { ok: false, detail: `getmatchdata/bl1 HTTP ${res.status}`, httpStatus: res.status };
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return { ok: false, detail: "Expected a match array", httpStatus: res.status };
      return { ok: true, detail: `Bundesliga current matchday returned ${body.length} matches`, httpStatus: res.status };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "OpenLigaDB request failed", httpStatus: null };
    }
  },
  async poll(fetchImpl) {
    const matches: unknown[] = [];
    const errors: string[] = [];
    let receivedAtMs = Date.now();
    let receivedMono = performance.now();
    for (const league of LEAGUES) {
      const res = await fetchImpl(`https://api.openligadb.de/getmatchdata/${league}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const body = await readJsonBody(res);
      receivedAtMs = body.receivedAtMs;
      receivedMono = body.receivedMono;
      if (!res.ok) {
        errors.push(`${league} HTTP ${res.status}`);
        continue;
      }
      if (Array.isArray(body.raw)) matches.push(...body.raw);
      else errors.push(`${league} not an array`);
    }
    if (matches.length === 0 && errors.length === LEAGUES.length) {
      throw new Error(errors.join("; "));
    }
    return { raw: { matches, errors }, httpStatus: 200, receivedAtMs, receivedMono };
  },
  normalize: normalizeOpenLiga,
};

export function normalizeOpenLiga(raw: unknown): NormalizeResult {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { matches?: unknown }).matches)
      ? (raw as { matches: unknown[] }).matches
      : null;
  if (!list) return { snapshots: [], malformed: 1 };
  const snapshots: ProviderSnapshot[] = [];
  let malformed = 0;
  for (const item of list) {
    const snap = one(item);
    if (!snap) malformed += 1;
    else snapshots.push(snap);
  }
  return { snapshots, malformed };
}

function one(item: unknown): ProviderSnapshot | null {
  if (!item || typeof item !== "object") return null;
  const m = item as Record<string, unknown>;
  const team1 = isObj(m.team1) ? m.team1 : null;
  const team2 = isObj(m.team2) ? m.team2 : null;
  const home = team1 && typeof team1.teamName === "string" ? team1.teamName : "";
  const away = team2 && typeof team2.teamName === "string" ? team2.teamName : "";
  if (!home || !away) return null;
  const kickoff = typeof m.matchDateTimeUTC === "string" ? ensureZ(m.matchDateTimeUTC) : null;
  const results = Array.isArray(m.matchResults) ? m.matchResults.filter(isObj) : [];
  const current = pickResult(results);
  const goals = Array.isArray(m.goals) ? m.goals.filter(isObj) : [];
  const finished = m.matchIsFinished === true;
  const kickMs = kickoff ? Date.parse(kickoff) : NaN;
  const now = Date.now();
  let status: CanonicalStatus = "SCHEDULED";
  if (finished) status = "FINISHED";
  else if (Number.isFinite(kickMs) && now >= kickMs && (current || goals.length > 0)) status = "IN_PLAY";
  else if (Number.isFinite(kickMs) && now >= kickMs && now - kickMs < 120 * 60 * 1000) status = "IN_PLAY";
  else if (Number.isFinite(kickMs) && now < kickMs) status = "SCHEDULED";
  else status = "UNKNOWN";

  const homeId = team1 && team1.teamId != null ? String(team1.teamId) : home;
  const awayId = team2 && team2.teamId != null ? String(team2.teamId) : away;
  const events: DraftEvent[] = goals
    .slice()
    .sort((a, b) => Number(a.matchMinute ?? 0) - Number(b.matchMinute ?? 0))
    .map((g) => {
      const minute = typeof g.matchMinute === "number" ? g.matchMinute : null;
      const scoreHome = typeof g.scoreTeam1 === "number" ? g.scoreTeam1 : null;
      const scoreAway = typeof g.scoreTeam2 === "number" ? g.scoreTeam2 : null;
      const side =
        g.scoringTeamId != null && String(g.scoringTeamId) === homeId
          ? "home"
          : g.scoringTeamId != null && String(g.scoringTeamId) === awayId
            ? "away"
            : null;
      return {
        type: g.isPenalty === true ? "PENALTY" : "GOAL",
        certainty: "unspecified" as const,
        providerEventId: g.goalID != null ? String(g.goalID) : null,
        minute,
        clock: minute != null ? `${minute}'` : null,
        period: g.isOvertime === true ? 3 : minute != null && minute > 45 ? 2 : 1,
        scoreHome,
        scoreAway,
        teamSide: side,
        player: typeof g.goalGetterName === "string" ? g.goalGetterName : null,
        detail: g.isOwnGoal === true ? "own goal" : g.isPenalty === true ? "penalty" : null,
        providerEventTimestamp: null,
        sequence: null,
      };
    });

  const updated = typeof m.lastUpdateDateTime === "string" ? Date.parse(m.lastUpdateDateTime) : NaN;
  return {
    provider: "openligadb",
    providerMatchId: String(m.matchID ?? ""),
    home,
    away,
    homeId,
    awayId,
    kickoff,
    competition: typeof m.leagueName === "string" ? m.leagueName : null,
    scoreHome: current ? num(current.pointsTeam1) : goals.length ? events[events.length - 1]?.scoreHome ?? null : null,
    scoreAway: current ? num(current.pointsTeam2) : goals.length ? events[events.length - 1]?.scoreAway ?? null : null,
    status,
    rawStatus: finished ? "matchIsFinished" : status,
    clock: null,
    minute: events.length ? events[events.length - 1]?.minute ?? null : null,
    period: null,
    sequence: Number.isFinite(updated) ? updated : null,
    events,
  };
}

function pickResult(results: Record<string, unknown>[]): Record<string, unknown> | null {
  if (results.length === 0) return null;
  return results.reduce((best, row) => {
    const order = typeof row.resultOrderID === "number" ? row.resultOrderID : -1;
    const bestOrder = typeof best.resultOrderID === "number" ? best.resultOrderID : -1;
    return order >= bestOrder ? row : best;
  });
}

function ensureZ(value: string): string {
  return /z$/i.test(value) ? value : `${value}Z`;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
