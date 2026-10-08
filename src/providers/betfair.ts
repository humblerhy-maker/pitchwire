import tls from "node:tls";
import type { DraftEvent, ProviderSnapshot } from "../engine/model.ts";
import type { LiveSportsProvider, NormalizeResult, PollPayload, ValidationReport } from "./types.ts";

/**
 * Betfair Exchange Stream API.
 * Host and protocol from the official stream docs and ESASwaggerSchema.json
 * (stream-api.betfair.com:443, CRLF JSON, op=authentication / marketSubscription / mcm).
 * Football eventTypeId 1 is stated in Betfair's Getting Started page.
 * suspendReason is a string on MarketDefinition. The stream docs list, for soccer:
 * Goal, Third Party Unavailable, Penalty, Red Card, Non In Play Market.
 * A forum note also lists Scout Unavailable. Scores are NOT in this API
 * (Betfair Developer Program: "football scores and incidents aren't available").
 * A Goal suspension is a provisional market signal, never a confirmed goal.
 * Delayed app keys are officially 1–180 seconds behind. This adapter refuses them.
 */

const STREAM_HOST = "stream-api.betfair.com";
const STREAM_PORT = 443;
const BETTING_URL = "https://api.betfair.com/betting/json-rpc";
const GOAL_REASONS = new Set(["Goal"]);
const OTHER_REASONS = new Set(["Penalty", "Red Card"]);

export interface CatalogueMarket {
  marketId: string;
  eventId: string | null;
  name: string;
  kickoff: string | null;
}

export interface SuspensionHit {
  marketId: string;
  reason: string;
  pt: number | null;
  inPlay: boolean;
}

let appKey = process.env.BETFAIR_APP_KEY?.trim() || "";
let session = process.env.BETFAIR_SESSION?.trim() || "";
let tier = process.env.BETFAIR_KEY_TIER?.trim() || "";

const catalogue = new Map<string, CatalogueMarket>();
const pending: Buffered[] = [];
const queue: Buffered[] = [];
const announced = new Set<string>();
let socket: tls.TLSSocket | null = null;
let buffer = "";
let lastError = "";
let connected = false;
let lastCatalogueAt = 0;
let subId = 1;

interface Buffered {
  receivedAtMs: number;
  receivedMono: number;
  parsedAtMs: number | null;
  marketId: string;
  reason: string;
  pt: number | null;
  home: string;
  away: string;
  kickoff: string | null;
}

export function setBetfairCredentials(key: string, nextSession: string, nextTier: string): void {
  appKey = key.trim();
  session = nextSession.trim();
  tier = nextTier.trim();
  stopBetfair();
}

export function betfairReady(): boolean {
  return appKey.length > 0 && session.length > 0 && tier === "live";
}

export function betfairBlockedReason(): string {
  if (tier && tier !== "live") {
    return "Refused. Betfair's own key table says a delayed app key is 1–180 seconds behind. That cannot be an early goal source. A live app key is a separate product (the public key page lists a £299 activation fee) and is personal-use unless Betfair approves commercial use.";
  }
  if (!appKey || !session) {
    return "Not connected. Needs BETFAIR_APP_KEY, BETFAIR_SESSION, and BETFAIR_KEY_TIER=live. Football scores are not in the Exchange API. suspendReason Goal is only a market suspension.";
  }
  return "Not connected.";
}

export function stopBetfair(): void {
  connected = false;
  buffer = "";
  pending.length = 0;
  queue.length = 0;
  announced.clear();
  if (socket) {
    socket.destroy();
    socket = null;
  }
}

export function suspensionsFromStreamObject(message: unknown): SuspensionHit[] {
  if (!message || typeof message !== "object") return [];
  const msg = message as { op?: unknown; mc?: unknown; pt?: unknown };
  if (msg.op !== "mcm" || !Array.isArray(msg.mc)) return [];
  const pt = typeof msg.pt === "number" && Number.isFinite(msg.pt) ? msg.pt : null;
  const hits: SuspensionHit[] = [];
  for (const change of msg.mc) {
    if (!change || typeof change !== "object") continue;
    const row = change as { id?: unknown; marketDefinition?: unknown };
    const marketId = typeof row.id === "string" ? row.id : "";
    const def = row.marketDefinition;
    if (!marketId || !def || typeof def !== "object") continue;
    const market = def as { status?: unknown; suspendReason?: unknown; inPlay?: unknown };
    if (market.status !== "SUSPENDED") continue;
    if (market.inPlay !== true) continue;
    const reason = typeof market.suspendReason === "string" ? market.suspendReason.trim() : "";
    if (!GOAL_REASONS.has(reason) && !OTHER_REASONS.has(reason)) continue;
    hits.push({ marketId, reason, pt, inPlay: true });
  }
  return hits;
}

/** Betfair event names are "Home v Away". Anything else is left unmatched. */
export function splitEventName(name: string): { home: string; away: string } | null {
  const parts = name.split(" v ");
  if (parts.length !== 2) return null;
  const home = parts[0]?.trim() ?? "";
  const away = parts[1]?.trim() ?? "";
  if (!home || !away) return null;
  return { home, away };
}

export const betfairProvider: LiveSportsProvider = {
  capabilities: {
    id: "betfair",
    label: "Betfair suspension (provisional)",
    supportsLiveMatches: true,
    supportsGoalEvents: false,
    supportsWebsocket: false,
    supportsSse: false,
    supportsPush: true,
    supportsTimestamps: false,
    transport: "stream",
    documentedUpdateMs: null,
    pollIntervalMs: 1000,
    official: true,
    requiresKey: true,
    role: "candidate",
    freeAccess: false,
    trial: false,
    documentedLatency:
      "Push over an SSL socket, not a WebSocket. No published goal-detection SLA. The message field pt is Betfair's publication clock, not the moment of the kick. A delayed app key is officially 1–180 seconds behind and is refused.",
    upstream:
      "Betfair exchange. suspendReason Goal means the match-odds market halted. No scorer and no score. Whether a scout or an official feed triggered the halt: UNKNOWN — REQUIRES VERIFICATION.",
    notes:
      "SSL socket stream-api.betfair.com:443. Subscribes only to in-play football MATCH_ODDS markets returned by listMarketCatalogue. Polling the socket drain every 1s is not the event interval.",
  },
  configured: () => betfairReady(),
  disconnectedDetail: () => (lastError ? `${betfairBlockedReason()} Last error: ${lastError}` : betfairBlockedReason()),
  async validate(): Promise<ValidationReport> {
    if (!betfairReady()) return { ok: false, detail: betfairBlockedReason(), httpStatus: null };
    try {
      const markets = await loadCatalogue();
      ensureStream();
      return {
        ok: true,
        detail: `Catalogue returned ${markets.length} in-play match-odds markets. Stream ${connected ? "up" : "connecting"}. No goals are invented from an empty catalogue.`,
        httpStatus: 200,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Betfair validate failed";
      return { ok: false, detail: lastError, httpStatus: null };
    }
  },
  async poll(): Promise<PollPayload> {
    if (!betfairReady()) throw new Error(betfairBlockedReason());
    const now = Date.now();
    if (now - lastCatalogueAt > 30_000) await loadCatalogue();
    ensureStream();
    if (lastError && !connected) throw new Error(lastError);
    flushPending();
    const arrivals = queue.splice(0, queue.length);
    const presence = presenceBatch(now);
    return {
      raw: [...presence, ...arrivals],
      httpStatus: 200,
      receivedAtMs: now,
      receivedMono: performance.now(),
    };
  },
  normalize(raw: unknown): NormalizeResult {
    if (!Array.isArray(raw)) return { snapshots: [], malformed: 0 };
    const snapshots: ProviderSnapshot[] = [];
    let malformed = 0;
    for (const item of raw) {
      const snap = snapshotFromBuffered(item);
      if (!snap) malformed += 1;
      else snapshots.push(snap);
    }
    return { snapshots, malformed };
  },
};

function snapshotFromBuffered(item: unknown): ProviderSnapshot | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Partial<Buffered>;
  if (!row.home || !row.away || !row.marketId || !row.receivedAtMs) return null;
  if (!row.reason) {
    return {
      provider: "betfair",
      providerMatchId: row.marketId,
      home: row.home,
      away: row.away,
      homeId: row.home,
      awayId: row.away,
      kickoff: row.kickoff ?? null,
      competition: "Betfair match odds",
      scoreHome: null,
      scoreAway: null,
      status: "IN_PLAY",
      rawStatus: "OPEN",
      clock: null,
      minute: null,
      period: null,
      sequence: null,
      events: [],
      receivedAtMs: row.receivedAtMs,
      receivedMono: row.receivedMono,
      parsedAtMs: row.parsedAtMs ?? undefined,
    };
  }
  const publication = typeof row.pt === "number" ? new Date(row.pt).toISOString() : null;
  const event: DraftEvent = {
    type: row.reason === "Goal" ? "PROVISIONAL_GOAL" : row.reason === "Penalty" ? "PENALTY" : "RED_CARD",
    certainty: "provisional",
    providerEventId: `${row.marketId}:${row.reason}:${row.pt ?? row.receivedAtMs}`,
    minute: null,
    clock: null,
    period: null,
    scoreHome: null,
    scoreAway: null,
    teamSide: null,
    player: null,
    detail:
      row.reason === "Goal"
        ? "Betfair match-odds market suspended with suspendReason Goal. Not a confirmed goal. No score in this payload."
        : `Betfair match-odds market suspended with suspendReason ${row.reason}. Provisional. No score in this payload.`,
    providerEventTimestamp: null,
    providerPublicationTimestamp: publication,
    sequence: row.pt ?? null,
  };
  return {
    provider: "betfair",
    providerMatchId: row.marketId,
    home: row.home,
    away: row.away,
    homeId: row.home,
    awayId: row.away,
    kickoff: row.kickoff ?? null,
    competition: "Betfair match odds",
    scoreHome: null,
    scoreAway: null,
    status: "IN_PLAY",
    rawStatus: "SUSPENDED",
    clock: null,
    minute: null,
    period: null,
    sequence: row.pt ?? null,
    events: [event],
    receivedAtMs: row.receivedAtMs,
    receivedMono: row.receivedMono,
    parsedAtMs: row.parsedAtMs ?? undefined,
  };
}

async function loadCatalogue(): Promise<CatalogueMarket[]> {
  const body = {
    jsonrpc: "2.0",
    method: "SportsAPING/v1.0/listMarketCatalogue",
    params: {
      filter: { eventTypeIds: ["1"], marketTypeCodes: ["MATCH_ODDS"], inPlayOnly: true },
      maxResults: 60,
      marketProjection: ["EVENT", "MARKET_START_TIME"],
    },
    id: 1,
  };
  const res = await fetch(BETTING_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Application": appKey,
      "X-Authentication": session,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  const receivedAt = Date.now();
  lastCatalogueAt = receivedAt;
  if (!res.ok) throw new Error(`Betfair catalogue HTTP ${res.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Betfair catalogue was not JSON");
  }
  const error = (parsed as { error?: { message?: string } } | null)?.error?.message;
  if (error) throw new Error(error);
  const result = (parsed as { result?: unknown } | null)?.result;
  if (!Array.isArray(result)) throw new Error("Betfair catalogue has no result array");
  const markets: CatalogueMarket[] = [];
  catalogue.clear();
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const row = item as { marketId?: unknown; marketStartTime?: unknown; event?: { name?: unknown; id?: unknown; openDate?: unknown } };
    const marketId = typeof row.marketId === "string" ? row.marketId : "";
    const name = typeof row.event?.name === "string" ? row.event.name : "";
    if (!marketId || !splitEventName(name)) continue;
    const kickoff =
      (typeof row.event?.openDate === "string" && row.event.openDate) ||
      (typeof row.marketStartTime === "string" && row.marketStartTime) ||
      null;
    const market: CatalogueMarket = {
      marketId,
      eventId: typeof row.event?.id === "string" ? row.event.id : null,
      name,
      kickoff,
    };
    catalogue.set(marketId, market);
    markets.push(market);
  }
  if (connected) sendSubscription();
  flushPending();
  return markets;
}

function ensureStream(): void {
  if (socket && !socket.destroyed) return;
  lastError = "";
  buffer = "";
  const next = tls.connect({ host: STREAM_HOST, port: STREAM_PORT, servername: STREAM_HOST }, () => {
    connected = true;
    send({ op: "authentication", id: subId++, appKey, session });
  });
  socket = next;
  next.setEncoding("utf8");
  next.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
      idx = buffer.indexOf("\n");
    }
  });
  next.on("error", (err) => {
    connected = false;
    lastError = err.message;
  });
  next.on("close", () => {
    connected = false;
    socket = null;
  });
}

function onLine(line: string): void {
  const receivedAtMs = Date.now();
  const receivedMono = performance.now();
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  const parsedAtMs = Date.now();
  const op = (message as { op?: string } | null)?.op;
  if (op === "status") {
    const code = (message as { statusCode?: string }).statusCode;
    if (code && code !== "SUCCESS") {
      lastError = `Betfair stream status ${code}`;
      socket?.destroy();
    } else if (catalogue.size > 0) {
      sendSubscription();
    }
    return;
  }
  if (op === "connection") return;
  for (const hit of suspensionsFromStreamObject(message)) {
    const known = catalogue.get(hit.marketId);
    const names = known ? splitEventName(known.name) : null;
    const item: Buffered = {
      receivedAtMs,
      receivedMono,
      parsedAtMs,
      marketId: hit.marketId,
      reason: hit.reason,
      pt: hit.pt,
      home: names?.home ?? "",
      away: names?.away ?? "",
      kickoff: known?.kickoff ?? null,
    };
    if (!names) pending.push(item);
    else queue.push(item);
    if (pending.length > 200) pending.splice(0, pending.length - 200);
  }
}

function flushPending(): void {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const item = pending[i]!;
    const known = catalogue.get(item.marketId);
    const names = known ? splitEventName(known.name) : null;
    if (!names) continue;
    item.home = names.home;
    item.away = names.away;
    item.kickoff = known?.kickoff ?? item.kickoff;
    queue.push(item);
    pending.splice(i, 1);
  }
}

function presenceBatch(now: number): Buffered[] {
  const mono = performance.now();
  const out: Buffered[] = [];
  for (const market of catalogue.values()) {
    if (announced.has(market.marketId)) continue;
    const names = splitEventName(market.name);
    if (!names) continue;
    announced.add(market.marketId);
    out.push({
      receivedAtMs: now,
      receivedMono: mono,
      parsedAtMs: null,
      marketId: market.marketId,
      reason: "",
      pt: null,
      home: names.home,
      away: names.away,
      kickoff: market.kickoff,
    });
  }
  return out;
}

function sendSubscription(): void {
  const marketIds = [...catalogue.keys()].slice(0, 60);
  if (marketIds.length === 0) return;
  send({
    op: "marketSubscription",
    id: subId++,
    marketFilter: { marketIds },
    marketDataFilter: { fields: ["EX_MARKET_DEF"] },
  });
}

function send(message: unknown): void {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\r\n`);
}
