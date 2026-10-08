import { EventEngine } from "../engine/engine.ts";
import { backoffMs } from "../engine/ids.ts";
import type {
  ConflictRecord,
  ProviderHealthState,
  PublicBoard,
  PublicEvent,
  PublicMatch,
  PublicProvider,
  Quantiles,
  RunMode,
} from "../engine/model.ts";
import { apiFootballProvider, setApiFootballKey } from "../providers/apifootball.ts";
import { betfairProvider, betfairBlockedReason, setBetfairCredentials, stopBetfair } from "../providers/betfair.ts";
import { demoProvider, demoSnapshot } from "../providers/demo.ts";
import { espnProvider } from "../providers/espn.ts";
import { openLigaProvider } from "../providers/openligadb.ts";
import { setSportmonksToken, sportmonksProvider } from "../providers/sportmonks.ts";
import { sportradarProvider } from "../providers/sportradar.ts";
import type { LiveSportsProvider, ProviderCapabilities, ValidationReport } from "../providers/types.ts";

export interface WireMessage {
  kind: "snapshot" | "event" | "match" | "providers";
  board?: PublicBoard;
  event?: PublicEvent;
  match?: PublicMatch;
  providers?: PublicProvider[];
}

interface ProviderRuntime {
  provider: LiveSportsProvider;
  health: ProviderHealthState;
  detail: string;
  failures: number;
  reconnects: number;
  eventsReceived: number;
  malformed: number;
  lastSuccessAt: string | null;
  validation: ValidationReport | null;
  enabled: boolean;
}

interface JournalRow {
  eventId: string;
  provider: string;
  matchId: string | null;
  raw: string;
  providerTimestamp: string | null;
  receivedAt: string;
  normalized: string | null;
  processingMs: number | null;
  publishedAt: string | null;
}

type Listener = (msg: WireMessage) => void;

const g = globalThis as typeof globalThis & {
  __pitchwire?: Runtime;
};

export function getRuntime(): Runtime {
  if (!g.__pitchwire) g.__pitchwire = new Runtime();
  return g.__pitchwire;
}

class Runtime {
  readonly engine = new EventEngine();
  private providers: ProviderRuntime[];
  private listeners = new Set<Listener>();
  private generation = 0;
  private started = false;
  private firstCycle: Promise<void> | null = null;
  private resolveFirst: (() => void) | null = null;
  private demoStartedAt = 0;
  private journal: JournalRow[] = [];
  private replayLog: PublicEvent[] = [];
  readonly startedAt = new Date().toISOString();
  mode: RunMode = process.env.PITCHWIRE_MODE === "demo" ? "demo" : "live";
  /** Set by the dev server after it attaches /ws/live. Production has no socket. */
  websocket = false;

  enableWebsocket(): void {
    this.websocket = true;
  }

  constructor() {
    const espnOn = process.env.ESPN_ENABLED !== "0";
    const ligaOn = process.env.OPENLIGADB_ENABLED !== "0";
    this.providers = [
      espnProvider,
      openLigaProvider,
      betfairProvider,
      sportradarProvider,
      apiFootballProvider,
      sportmonksProvider,
      demoProvider,
    ].map(
      (provider) => ({
        provider,
        health: "DISCONNECTED" as ProviderHealthState,
        detail: "Not started",
        failures: 0,
        reconnects: 0,
        eventsReceived: 0,
        malformed: 0,
        lastSuccessAt: null,
        validation: null,
        enabled:
          provider.capabilities.id === "demo"
            ? this.mode === "demo"
            : provider.capabilities.id === "espn"
              ? espnOn
              : provider.capabilities.id === "openligadb"
                ? ligaOn
                : provider.configured(),
      }),
    );
    this.engine.mode = this.mode;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    const gen = this.generation;
    this.firstCycle = new Promise((resolve) => {
      this.resolveFirst = resolve;
    });
    if (this.mode === "live") this.runLive(gen);
    else this.runDemo(gen);
    void this.persistLoop();
  }

  whenFirstCycle(): Promise<void> {
    this.start();
    return Promise.race([
      this.firstCycle ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 8000)),
    ]);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ kind: "snapshot", board: this.publicBoard() });
    return () => this.listeners.delete(listener);
  }

  setMode(mode: RunMode): PublicBoard {
    if (mode !== "live" && mode !== "demo") return this.publicBoard();
    stopBetfair();
    this.mode = mode;
    this.engine.reset(mode);
    this.replayLog = [];
    this.generation += 1;
    const gen = this.generation;
    for (const row of this.providers) {
      row.enabled =
        row.provider.capabilities.id === "demo"
          ? mode === "demo"
          : mode === "live" &&
            (row.provider.capabilities.id === "espn"
              ? process.env.ESPN_ENABLED !== "0"
              : row.provider.capabilities.id === "openligadb"
                ? process.env.OPENLIGADB_ENABLED !== "0"
                : row.provider.configured());
      row.health = row.enabled ? "RECONNECTING" : "DISCONNECTED";
      row.detail = row.enabled ? "Switching mode" : "Disabled in this mode";
    }
    this.demoStartedAt = Date.now();
    if (mode === "live") this.runLive(gen);
    else this.runDemo(gen);
    this.broadcast({ kind: "snapshot", board: this.publicBoard() });
    return this.publicBoard();
  }

  setCredential(
    providerId: string,
    secret: string,
    extra?: { session?: string; tier?: string },
  ): { ok: boolean; detail: string } {
    if (providerId === "betfair") {
      const session = extra?.session ?? "";
      const tier = (extra?.tier ?? "").trim();
      setBetfairCredentials(secret, session, tier);
      const row = this.providers.find((p) => p.provider.capabilities.id === "betfair");
      const ready = tier === "live" && row?.provider.configured();
      if (row) {
        row.enabled = this.mode === "live" && Boolean(ready);
        row.health = row.enabled ? "RECONNECTING" : "DISCONNECTED";
        row.detail = row.enabled
          ? "Live key stored in memory. Next cycle will open the stream. A Goal suspension is provisional and has no score."
          : betfairBlockedReason();
        row.validation = null;
      }
      this.broadcast({ kind: "providers", providers: this.providerPublic() });
      if (!ready) return { ok: false, detail: betfairBlockedReason() };
      return { ok: true, detail: "Stored in server memory for this process only. Not written to disk." };
    }
    if (providerId === "api-football") setApiFootballKey(secret);
    else if (providerId === "sportmonks") setSportmonksToken(secret);
    else if (providerId === "sportradar") {
      return {
        ok: false,
        detail: sportradarProvider.disconnectedDetail?.() ?? "Sportradar is not connected.",
      };
    } else return { ok: false, detail: "That provider does not take a key" };
    const row = this.providers.find((p) => p.provider.capabilities.id === providerId);
    if (row) {
      row.enabled = this.mode === "live" && row.provider.configured();
      row.detail = row.enabled ? "Key stored in memory. Next poll will validate it." : "Key cleared";
      row.health = row.enabled ? "RECONNECTING" : "DISCONNECTED";
    }
    this.broadcast({ kind: "providers", providers: this.providerPublic() });
    return { ok: true, detail: "Stored in server memory for this process only. Not written to disk." };
  }

  async replayFixture(raw: unknown, providerId: string): Promise<{ events: PublicEvent[]; detail: string }> {
    const provider = this.providers.find((p) => p.provider.capabilities.id === providerId)?.provider;
    if (!provider) return { events: [], detail: "Unknown provider" };
    const replayEngine = new EventEngine();
    replayEngine.mode = "live";
    replayEngine.replay = true;
    const normalized = provider.normalize(raw);
    const receivedAtMs = Date.now();
    const result = replayEngine.ingest(normalized.snapshots, {
      receivedAtMs,
      receivedMono: performance.now(),
      mode: "live",
    });
    this.replayLog = result.published.slice(-100);
    for (const event of result.published) {
      if (!event.backfill || event.type === "GOAL" || event.type === "PENALTY") {
        this.broadcast({ kind: "event", event: { ...event, replay: true, backfill: true } });
      }
    }
    return {
      events: result.published,
      detail: `Replayed ${normalized.snapshots.length} matches, published ${result.published.length} events through a fresh engine. Live state was not modified.`,
    };
  }

  publicBoard(): PublicBoard {
    const c = this.engine.counters;
    return {
      mode: this.mode,
      startedAt: this.startedAt,
      serverNow: new Date().toISOString(),
      websocket: this.websocket,
      matches: this.engine.listMatches(),
      providers: this.providerPublic(),
      metrics: {
        received: c.received,
        processed: c.processed,
        published: c.published,
        duplicates: c.duplicates,
        conflicts: c.conflicts,
        failed: c.failed,
        malformed: c.malformed,
        outOfOrder: c.outOfOrder,
        processing: c.processing.quantiles(),
        detectionUpperBound: c.detectionUpperBound.quantiles(),
        providerStampToReceive: c.providerStampToReceive.quantiles(),
      },
      recentConflicts: this.engine.conflicts(),
      journalCount: this.journal.length,
      replay: this.replayLog.slice(-30),
      races: this.engine.sourceRaces(),
    };
  }

  prometheus(): string {
    const lines = [this.engine.counters.prometheus().trimEnd()];
    lines.push("# HELP pitchwire_provider_up 1 when the last poll succeeded");
    lines.push("# TYPE pitchwire_provider_up gauge");
    for (const row of this.providers) {
      const up = row.health === "HEALTHY" || row.health === "CONNECTED" ? 1 : 0;
      lines.push(`pitchwire_provider_up{provider="${row.provider.capabilities.id}"} ${up}`);
      lines.push(
        `pitchwire_provider_failures{provider="${row.provider.capabilities.id}"} ${row.failures}`,
      );
      lines.push(
        `pitchwire_provider_reconnects{provider="${row.provider.capabilities.id}"} ${row.reconnects}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  journalSlice(limit = 50): JournalRow[] {
    return this.journal.slice(-limit).reverse();
  }

  private providerPublic(): PublicProvider[] {
    return this.providers.map((row) => ({
      id: row.provider.capabilities.id,
      label: row.provider.capabilities.label,
      enabled: row.enabled,
      configured: row.provider.configured(),
      health: row.health,
      detail: row.detail,
      capabilities: caps(row.provider.capabilities),
      failures: row.failures,
      reconnects: row.reconnects,
      eventsReceived: row.eventsReceived,
      eventsMalformed: row.malformed,
      lastSuccessAt: row.lastSuccessAt,
      validation: row.validation?.detail ?? "Not validated yet",
    }));
  }

  private async runLive(gen: number): Promise<void> {
    const jobs = this.providers
      .filter((row) => row.provider.capabilities.id !== "demo")
      .map((row) => this.supervise(row, gen));
    await Promise.all(jobs.map((job) => job.first));
    this.resolveFirst?.();
    this.resolveFirst = null;
  }

  private supervise(row: ProviderRuntime, gen: number): { first: Promise<void> } {
    let firstDone = false;
    let resolveFirst = () => {};
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const loop = async () => {
      let attempt = 0;
      while (gen === this.generation && this.mode === "live") {
        if (!row.enabled || !row.provider.configured()) {
          row.health = "DISCONNECTED";
          row.detail = row.provider.configured()
            ? "Disabled"
            : (row.provider.disconnectedDetail?.() ??
              "Missing credential. Live mode will not invent data for this provider.");
          if (!firstDone) {
            firstDone = true;
            resolveFirst();
          }
          await sleep(2000);
          continue;
        }
        const interval = row.provider.capabilities.pollIntervalMs ?? 15000;
        try {
          if (!row.validation) {
            row.validation = await row.provider.validate();
            if (!row.validation.ok) {
              throw new Error(row.validation.detail);
            }
          }
          const polled = await row.provider.poll(fetch);
          const normalized = row.provider.normalize(polled.raw);
          row.malformed += normalized.malformed;
          this.engine.counters.malformed += normalized.malformed;
          const result = this.engine.ingest(normalized.snapshots, {
            receivedAtMs: polled.receivedAtMs,
            receivedMono: polled.receivedMono,
            parsedAtMs: polled.parsedAtMs,
            mode: "live",
          });
          row.eventsReceived += result.published.length;
          row.failures = 0;
          row.health = "HEALTHY";
          row.lastSuccessAt = new Date().toISOString();
          row.detail = `${normalized.snapshots.length} matches, ${result.published.length} new events`;
          this.rememberRaw(row.provider.capabilities.id, polled.raw, result.published, polled.receivedAtMs);
          this.emitResult(result);
          attempt = 0;
          if (!firstDone) {
            firstDone = true;
            resolveFirst();
          }
          await sleep(interval);
        } catch (err) {
          row.failures += 1;
          row.reconnects += 1;
          this.engine.counters.failed += 1;
          row.health = row.failures >= 3 ? "DEGRADED" : "RECONNECTING";
          row.detail = err instanceof Error ? err.message : "Poll failed";
          row.validation = null;
          if (!firstDone) {
            firstDone = true;
            resolveFirst();
          }
          const wait = backoffMs(attempt, Math.random());
          attempt += 1;
          await sleep(wait);
        }
      }
      if (!firstDone) resolveFirst();
    };
    void loop();
    return { first };
  }

  private async runDemo(gen: number): Promise<void> {
    this.demoStartedAt = Date.now();
    const row = this.providers.find((p) => p.provider.capabilities.id === "demo");
    if (row) {
      row.enabled = true;
      row.health = "HEALTHY";
      row.detail = "Playing the deterministic Harbour FC vs Northbridge script";
      row.validation = { ok: true, detail: "Local script", httpStatus: null };
    }
    this.resolveFirst?.();
    this.resolveFirst = null;
    while (gen === this.generation && this.mode === "demo") {
      const elapsed = Date.now() - this.demoStartedAt;
      const snap = demoSnapshot(elapsed);
      const receivedMono = performance.now();
      const receivedAtMs = Date.now();
      const result = this.engine.ingest([snap], { receivedAtMs, receivedMono, mode: "demo" });
      if (row) row.eventsReceived += result.published.length;
      this.emitResult(result);
      if (elapsed > 26_000) {
        this.engine.reset("demo");
        this.demoStartedAt = Date.now();
        this.broadcast({ kind: "snapshot", board: this.publicBoard() });
        continue;
      }
      await sleep(1000);
    }
  }

  private emitResult(result: {
    published: PublicEvent[];
    patched: PublicEvent[];
    matches: PublicMatch[];
    conflicts: ConflictRecord[];
  }): void {
    for (const event of result.published) this.broadcast({ kind: "event", event });
    for (const event of result.patched) this.broadcast({ kind: "event", event });
    for (const match of result.matches) this.broadcast({ kind: "match", match });
    if (result.conflicts.length || result.published.length) {
      this.broadcast({ kind: "providers", providers: this.providerPublic() });
    }
    const goalish = [...result.published, ...result.patched].some((event) => ALERT_TYPES.has(event.type));
    if (goalish) {
      this.broadcast({ kind: "snapshot", board: this.publicBoard() });
      fanoutEvents([...result.published, ...result.patched]);
    }
  }

  private rememberRaw(provider: string, raw: unknown, events: PublicEvent[], receivedAtMs: number): void {
    let text: string;
    try {
      text = JSON.stringify(raw);
    } catch {
      text = "\"unserializable\"";
    }
    if (text.length > 200_000) text = text.slice(0, 200_000);
    const row: JournalRow = {
      eventId: `raw_${provider}_${receivedAtMs}`,
      provider,
      matchId: events[0]?.matchId ?? null,
      raw: text,
      providerTimestamp: events.find((e) => e.providerEventTimestamp)?.providerEventTimestamp ?? null,
      receivedAt: new Date(receivedAtMs).toISOString(),
      normalized: events.length ? JSON.stringify(events.slice(0, 20)) : null,
      processingMs: events[0]?.processingMs ?? null,
      publishedAt: events[0]?.publishedTimestamp ?? null,
    };
    this.journal.push(row);
    if (this.journal.length > 200) this.journal.splice(0, this.journal.length - 200);
    this.queueDb(row);
  }

  private dbQueue: JournalRow[] = [];

  private queueDb(row: JournalRow): void {
    this.dbQueue.push(row);
  }

  private async persistLoop(): Promise<void> {
    for (;;) {
      await sleep(1000);
      if (this.dbQueue.length === 0) continue;
      const batch = this.dbQueue.splice(0, 25);
      try {
        const { getSql } = await import("../lib/db.ts");
        const sql = await getSql();
        for (const row of batch) {
          await sql.query(
            `insert into pitch_provider_events
              (event_id, provider, match_id, raw_payload, provider_timestamp, received_at, normalized, processing_ms, published_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict (event_id) do nothing`,
            [
              row.eventId,
              row.provider,
              row.matchId,
              row.raw,
              row.providerTimestamp,
              row.receivedAt,
              row.normalized,
              row.processingMs,
              row.publishedAt,
            ],
          );
        }
      } catch (err) {
        console.error("[pitchwire] journal persist failed", err instanceof Error ? err.message : err);
      }
    }
  }

  private broadcast(msg: WireMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
}

function caps(c: ProviderCapabilities): Record<string, string | number | boolean | null> {
  return {
    supports_live_matches: c.supportsLiveMatches,
    supports_goal_events: c.supportsGoalEvents,
    supports_websocket: c.supportsWebsocket,
    supports_sse: c.supportsSse,
    supports_push: c.supportsPush,
    supports_timestamps: c.supportsTimestamps,
    transport: c.transport,
    documented_update_ms: c.documentedUpdateMs,
    poll_interval_ms: c.pollIntervalMs,
    official: c.official,
    requires_key: c.requiresKey,
    role: c.role,
    free: c.freeAccess,
    trial: c.trial,
    documented_latency: c.documentedLatency,
    upstream: c.upstream,
    notes: c.notes,
  };
}

const ALERT_TYPES = new Set(["GOAL", "PENALTY", "PROVISIONAL_GOAL", "CONFIRMED_GOAL", "CANCELLED_GOAL", "SCORE_CHANGED"]);

function fanoutEvents(events: PublicEvent[]): void {
  const fresh = events.filter((event) => !event.backfill && !event.replay && ALERT_TYPES.has(event.type));
  if (fresh.length === 0) return;
  const webhook = process.env.PITCHWIRE_WEBHOOK_URL?.trim() ?? "";
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chat = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  for (const event of fresh) {
    const payload = {
      type: event.type,
      provider: event.provider,
      matchId: event.matchId,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      scoreHome: event.scoreHome,
      scoreAway: event.scoreAway,
      clock: event.clock,
      certainty: event.certainty,
      providerEventTimestamp: event.providerEventTimestamp,
      providerPublicationTimestamp: event.providerPublicationTimestamp,
      serverReceiveTimestamp: event.serverReceiveTimestamp,
      serverParseTimestamp: event.serverParseTimestamp,
      serverPublishTimestamp: event.publishedTimestamp,
    };
    if (webhook.startsWith("https://") || webhook.startsWith("http://")) {
      void fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      }).catch(() => undefined);
    }
    if (token && chat) {
      const text = `${event.type} ${event.homeTeam} ${event.scoreHome ?? "—"}-${event.scoreAway ?? "—"} ${event.awayTeam} via ${event.provider}. Provisional until a score is present.`;
      void fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text }),
        signal: AbortSignal.timeout(4000),
      }).catch(() => undefined);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { PublicBoard, Quantiles };
