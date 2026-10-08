import {
  backoffMs,
  canonicalMatchId,
  crossGoalKey,
  isGoalLike,
  providerFingerprint,
} from "./ids.ts";
import { Counters } from "./metrics.ts";
import { buildSourceRaces, type SourceRace } from "./race.ts";
import type {
  CanonicalStatus,
  ConflictRecord,
  DraftEvent,
  EventType,
  IngestMeta,
  Observation,
  ProviderSnapshot,
  PublicEvent,
  PublicMatch,
  ProviderViewPublic,
  RunMode,
} from "./model.ts";

interface StoredView {
  provider: string;
  providerMatchId: string;
  scoreHome: number | null;
  scoreAway: number | null;
  status: CanonicalStatus;
  clock: string | null;
  minute: number | null;
  receivedAtMs: number;
  sequence: number | null;
}

interface StoredMatch {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  kickoff: string | null;
  views: Map<string, StoredView>;
  events: PublicEvent[];
  conflicts: ConflictRecord[];
  created: boolean;
  lastStatus: CanonicalStatus | null;
  lastPeriod: number | null;
}

export interface IngestResult {
  published: PublicEvent[];
  patched: PublicEvent[];
  matches: PublicMatch[];
  malformed: number;
  duplicates: number;
  conflicts: ConflictRecord[];
  rejectedDemo: number;
  outOfOrder: number;
}

const MAX_EVENTS = 80;
const MAX_MATCHES = 400;

export class EventEngine {
  readonly counters = new Counters();
  private matches = new Map<string, StoredMatch>();
  private fingerprints = new Set<string>();
  private crossGoals = new Map<string, string>();
  private lastPollAt = new Map<string, number>();
  mode: RunMode = "live";
  replay = false;

  reset(mode?: RunMode): void {
    this.matches.clear();
    this.fingerprints.clear();
    this.crossGoals.clear();
    this.lastPollAt.clear();
    if (mode) this.mode = mode;
  }

  ingest(snapshots: ProviderSnapshot[], meta: IngestMeta): IngestResult {
    const published: PublicEvent[] = [];
    const patched: PublicEvent[] = [];
    const conflicts: ConflictRecord[] = [];
    const touched = new Set<string>();
    let duplicates = 0;
    let rejectedDemo = 0;
    let outOfOrder = 0;
    let malformed = 0;

    for (const snap of snapshots) {
      if (!snap || !snap.home || !snap.away || !snap.provider) {
        malformed += 1;
        this.counters.malformed += 1;
        continue;
      }
      if (this.mode === "live" && snap.provider === "demo") {
        rejectedDemo += 1;
        this.counters.dropped += 1;
        continue;
      }
      if (this.mode === "demo" && snap.provider !== "demo") {
        rejectedDemo += 1;
        this.counters.dropped += 1;
        continue;
      }

      this.counters.received += 1;
      this.counters.bumpProvider(snap.provider);

      const matchId = canonicalMatchId(snap.home, snap.away, snap.kickoff);
      let match = this.matches.get(matchId);
      const isNew = !match;
      if (!match) {
        match = {
          matchId,
          homeTeam: snap.home,
          awayTeam: snap.away,
          competition: snap.competition,
          kickoff: snap.kickoff,
          views: new Map(),
          events: [],
          conflicts: [],
          created: false,
          lastStatus: null,
          lastPeriod: null,
        };
        this.matches.set(matchId, match);
        this.pruneMatches();
      }
      if (snap.competition && !match.competition) match.competition = snap.competition;

      const prev = match.views.get(snap.provider);
      if (
        prev &&
        snap.sequence !== null &&
        prev.sequence !== null &&
        snap.sequence < prev.sequence
      ) {
        outOfOrder += 1;
        this.counters.outOfOrder += 1;
        this.counters.dropped += 1;
        const conflict = this.pushConflict(match, {
          detail: `${snap.provider} sent sequence ${snap.sequence} after ${prev.sequence}. State was not overwritten.`,
          providers: [snap.provider],
          atMs: meta.receivedAtMs,
        });
        conflicts.push(conflict);
        touched.add(matchId);
        continue;
      }

      const tick: IngestMeta = {
        ...meta,
        receivedAtMs: snap.receivedAtMs ?? meta.receivedAtMs,
        receivedMono: snap.receivedMono ?? meta.receivedMono,
      };
      const watchStart = snap.receivedAtMs != null ? null : (this.lastPollAt.get(snap.provider) ?? null);
      const watching = prev !== undefined;

      if (isNew) {
        const created = this.emit(match, snap, tick, watchStart, {
          type: "MATCH_CREATED",
          certainty: "unspecified",
          providerEventId: null,
          minute: snap.minute,
          clock: snap.clock,
          period: snap.period,
          scoreHome: snap.scoreHome,
          scoreAway: snap.scoreAway,
          teamSide: null,
          player: null,
          detail: null,
          providerEventTimestamp: null,
          sequence: snap.sequence,
        }, true, false);
        if (created) published.push(created);
      }

      this.emitStatusDiff(match, snap, tick, watchStart, published, isNew, watching);

      const scoreChanged =
        !!prev &&
        prev.scoreHome !== null &&
        prev.scoreAway !== null &&
        snap.scoreHome !== null &&
        snap.scoreAway !== null &&
        (prev.scoreHome !== snap.scoreHome || prev.scoreAway !== snap.scoreAway);

      if (
        prev &&
        prev.scoreHome !== null &&
        prev.scoreAway !== null &&
        snap.scoreHome !== null &&
        snap.scoreAway !== null &&
        (snap.scoreHome < prev.scoreHome || snap.scoreAway < prev.scoreAway)
      ) {
        const conflict = this.pushConflict(match, {
          detail: `${snap.provider} score moved ${prev.scoreHome}-${prev.scoreAway} → ${snap.scoreHome}-${snap.scoreAway} without a cancellation event.`,
          providers: [snap.provider],
          atMs: meta.receivedAtMs,
        });
        conflicts.push(conflict);
      }

      match.views.set(snap.provider, {
        provider: snap.provider,
        providerMatchId: snap.providerMatchId,
        scoreHome: snap.scoreHome,
        scoreAway: snap.scoreAway,
        status: snap.status,
        clock: snap.clock,
        minute: snap.minute,
        receivedAtMs: tick.receivedAtMs,
        sequence: snap.sequence,
      });

      const cross = this.reconcile(match, tick.receivedAtMs);
      if (cross) conflicts.push(cross);

      for (const draft of snap.events) {
        const event = this.emit(match, snap, tick, watchStart, draft, isNew, watching);
        if (event) {
          published.push(event);
        } else {
          duplicates += 1;
          const patchedEvent = this.noteDuplicateObservation(match, snap, draft, tick, watching);
          if (patchedEvent) patched.push(patchedEvent);
        }
      }

      if (scoreChanged && snap.scoreHome !== null && snap.scoreAway !== null) {
        const increased =
          !prev ||
          (prev.scoreHome ?? 0) < snap.scoreHome ||
          (prev.scoreAway ?? 0) < snap.scoreAway;
        const event = this.emit(match, snap, tick, watchStart, {
          type: increased ? "SCORE_CHANGED" : "SCORE_CHANGED",
          certainty: "unspecified",
          providerEventId: null,
          minute: snap.minute,
          clock: snap.clock,
          period: snap.period,
          scoreHome: snap.scoreHome,
          scoreAway: snap.scoreAway,
          teamSide:
            prev && snap.scoreHome !== null && (prev.scoreHome ?? 0) < snap.scoreHome
              ? "home"
              : prev && snap.scoreAway !== null && (prev.scoreAway ?? 0) < snap.scoreAway
                ? "away"
                : null,
          player: null,
          detail: "Score changed in the provider snapshot. No separate goal record was in this payload.",
          providerEventTimestamp: null,
          sequence: snap.sequence,
        }, false, watching);
        if (event) published.push(event);
        else duplicates += 1;
      }

      touched.add(matchId);
    }

    for (const snap of snapshots) {
      if (snap?.provider) this.lastPollAt.set(snap.provider, meta.receivedAtMs);
    }

    return {
      published,
      patched,
      matches: [...touched].map((id) => this.publicMatch(this.matches.get(id)!)).filter(Boolean),
      malformed,
      duplicates,
      conflicts,
      rejectedDemo,
      outOfOrder,
    };
  }

  listMatches(): PublicMatch[] {
    return [...this.matches.values()]
      .map((m) => this.publicMatch(m))
      .sort(sortMatches);
  }

  getMatch(id: string): PublicMatch | null {
    const m = this.matches.get(id);
    return m ? this.publicMatch(m) : null;
  }

  conflicts(): ConflictRecord[] {
    const all: ConflictRecord[] = [];
    for (const m of this.matches.values()) all.push(...m.conflicts);
    return all.slice(-100).reverse();
  }

  sourceRaces(nowMs = Date.now()): SourceRace[] {
    return buildSourceRaces(this.listMatches(), nowMs);
  }

  private emitStatusDiff(
    match: StoredMatch,
    snap: ProviderSnapshot,
    meta: IngestMeta,
    watchStart: number | null,
    published: PublicEvent[],
    backfill: boolean,
    watching: boolean,
  ): void {
    const prev = match.lastStatus;
    const drafts: DraftEvent[] = [];
    if (prev !== snap.status) {
      if (snap.status === "IN_PLAY" && prev !== "HALFTIME") {
        drafts.push(statusDraft("MATCH_STARTED", snap));
      }
      if (snap.status === "HALFTIME") drafts.push(statusDraft("PERIOD_ENDED", snap));
      if (snap.status === "IN_PLAY" && prev === "HALFTIME") {
        drafts.push(statusDraft("PERIOD_STARTED", snap));
      }
      if (snap.status === "FINISHED") drafts.push(statusDraft("MATCH_ENDED", snap));
      if (prev !== null) drafts.push(statusDraft("MATCH_STATUS_CHANGED", snap));
      match.lastStatus = snap.status;
    }
    if (snap.period !== null && match.lastPeriod !== null && snap.period !== match.lastPeriod) {
      if (snap.period > match.lastPeriod) drafts.push(statusDraft("PERIOD_STARTED", snap));
    }
    if (snap.period !== null) match.lastPeriod = snap.period;
    for (const draft of drafts) {
      const event = this.emit(match, snap, meta, watchStart, draft, backfill, watching);
      if (event) published.push(event);
    }
  }

  private emit(
    match: StoredMatch,
    snap: ProviderSnapshot,
    meta: IngestMeta,
    watchStart: number | null,
    draft: DraftEvent,
    backfill: boolean,
    watching: boolean,
  ): PublicEvent | null {
    const scoreHome = draft.scoreHome ?? snap.scoreHome;
    const scoreAway = draft.scoreAway ?? snap.scoreAway;
    const fp = providerFingerprint({
      provider: snap.provider,
      matchId: match.matchId,
      type: draft.type,
      providerEventId: draft.providerEventId,
      clock: draft.clock,
      teamSide: draft.teamSide,
      player: draft.player,
      scoreHome,
      scoreAway,
    });
    if (this.fingerprints.has(fp)) {
      return null;
    }

    if (
      isGoalLike(draft.type) &&
      draft.type !== "CANCELLED_GOAL" &&
      scoreHome !== null &&
      scoreAway !== null
    ) {
      const key = crossGoalKey(match.matchId, scoreHome, scoreAway);
      const existingId = this.crossGoals.get(key);
      if (existingId) {
        this.fingerprints.add(fp);
        return null;
      }
      // Reserve before push so a second event in the same batch dedupes.
      this.crossGoals.set(key, "pending");
    }

    this.fingerprints.add(fp);
    const publishedMono = performance.now();
    const processingMs = roundMs(publishedMono - meta.receivedMono);
    const serverReceiveTimestamp = new Date(meta.receivedAtMs).toISOString();
    const publishedTimestamp = new Date().toISOString();
    const parseMs = snap.parsedAtMs ?? meta.parsedAtMs;
    const serverParseTimestamp = parseMs != null ? new Date(parseMs).toISOString() : null;
    let providerStampToReceiveMs: number | null = null;
    if (draft.providerEventTimestamp) {
      const stamp = Date.parse(draft.providerEventTimestamp);
      if (Number.isFinite(stamp)) {
        providerStampToReceiveMs = meta.receivedAtMs - stamp;
      }
    }
    const inWatchWindow =
      !backfill &&
      watchStart !== null &&
      (draft.providerEventTimestamp
        ? Date.parse(draft.providerEventTimestamp) >= watchStart - 2000
        : true);
    const detectionUpperBoundMs =
      !backfill && watchStart !== null ? meta.receivedAtMs - watchStart : null;

    const event: PublicEvent = {
      eventId: `e_${fp.slice(0, 80)}_${hashTail(meta.receivedAtMs, draft.type)}`,
      type: draft.type,
      certainty: draft.certainty,
      provider: snap.provider,
      matchId: match.matchId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      teamSide: draft.teamSide,
      player: draft.player,
      clock: draft.clock ?? snap.clock,
      minute: draft.minute,
      period: draft.period,
      scoreHome,
      scoreAway,
      competition: match.competition,
      detail: draft.detail,
      status: snap.status,
      backfill: backfill || this.replay,
      replay: this.replay,
      providerEventTimestamp: draft.providerEventTimestamp,
      providerPublicationTimestamp: draft.providerPublicationTimestamp ?? null,
      serverReceiveTimestamp,
      serverParseTimestamp,
      publishedTimestamp,
      processingMs,
      detectionUpperBoundMs,
      providerStampToReceiveMs,
      inWatchWindow: inWatchWindow && !this.replay,
      observations: [
        {
          provider: snap.provider,
          receivedAt: serverReceiveTimestamp,
          providerEventTimestamp: draft.providerEventTimestamp,
          providerPublicationTimestamp: draft.providerPublicationTimestamp ?? null,
          serverParseTimestamp,
          serverPublishTimestamp: publishedTimestamp,
          backfill: !watching,
        },
      ],
    };

    if (isGoalLike(draft.type) && draft.type !== "CANCELLED_GOAL" && scoreHome !== null && scoreAway !== null) {
      this.crossGoals.set(crossGoalKey(match.matchId, scoreHome, scoreAway), event.eventId);
    }

    match.events.push(event);
    if (match.events.length > MAX_EVENTS) match.events.splice(0, match.events.length - MAX_EVENTS);
    this.counters.processed += 1;
    this.counters.published += 1;
    this.counters.processing.add(processingMs);
    if (event.inWatchWindow && detectionUpperBoundMs !== null && detectionUpperBoundMs >= 0) {
      this.counters.detectionUpperBound.add(detectionUpperBoundMs);
    }
    if (
      event.inWatchWindow &&
      providerStampToReceiveMs !== null &&
      providerStampToReceiveMs >= 0
    ) {
      this.counters.providerStampToReceive.add(providerStampToReceiveMs);
    }
    return event;
  }

  private noteDuplicateObservation(
    match: StoredMatch,
    snap: ProviderSnapshot,
    draft: DraftEvent,
    meta: IngestMeta,
    watching: boolean,
  ): PublicEvent | null {
    if (!isGoalLike(draft.type) || draft.type === "CANCELLED_GOAL") return null;
    const scoreHome = draft.scoreHome ?? snap.scoreHome;
    const scoreAway = draft.scoreAway ?? snap.scoreAway;
    if (scoreHome === null || scoreAway === null) return null;
    const key = crossGoalKey(match.matchId, scoreHome, scoreAway);
    const eventId = this.crossGoals.get(key);
    if (!eventId || eventId === "pending") return null;
    const event = match.events.find((e) => e.eventId === eventId);
    if (!event) return null;
    const parseMs = snap.parsedAtMs ?? meta.parsedAtMs;
    const obs: Observation = {
      provider: snap.provider,
      receivedAt: new Date(meta.receivedAtMs).toISOString(),
      providerEventTimestamp: draft.providerEventTimestamp,
      providerPublicationTimestamp: draft.providerPublicationTimestamp ?? null,
      serverParseTimestamp: parseMs != null ? new Date(parseMs).toISOString() : null,
      serverPublishTimestamp: new Date().toISOString(),
      backfill: !watching,
    };
    if (event.observations.some((o) => o.provider === obs.provider)) {
      return null;
    }
    event.observations.push(obs);
    if (!event.providerEventTimestamp && draft.providerEventTimestamp) {
      event.providerEventTimestamp = draft.providerEventTimestamp;
      const stamp = Date.parse(draft.providerEventTimestamp);
      if (Number.isFinite(stamp)) {
        event.providerStampToReceiveMs = meta.receivedAtMs - stamp;
        if (event.inWatchWindow && event.providerStampToReceiveMs >= 0) {
          this.counters.providerStampToReceive.add(event.providerStampToReceiveMs);
        }
      }
    }
    return event;
  }

  private reconcile(match: StoredMatch, atMs: number): ConflictRecord | null {
    const fresh = [...match.views.values()].filter((v) => atMs - v.receivedAtMs < 180_000);
    const scored = fresh.filter((v) => v.scoreHome !== null && v.scoreAway !== null);
    if (scored.length < 2) return null;
    const first = scored[0]!;
    const disagree = scored.filter(
      (v) => v.scoreHome !== first.scoreHome || v.scoreAway !== first.scoreAway,
    );
    if (disagree.length === 0) return null;
    const detail = scored
      .map((v) => `${v.provider} ${v.scoreHome}-${v.scoreAway}`)
      .join(" vs ");
    return this.pushConflict(match, {
      detail: `Score disagreement: ${detail}`,
      providers: scored.map((v) => v.provider),
      atMs,
    });
  }

  private pushConflict(
    match: StoredMatch,
    input: { detail: string; providers: string[]; atMs: number },
  ): ConflictRecord {
    const record: ConflictRecord = {
      matchId: match.matchId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      detail: input.detail,
      at: new Date(input.atMs).toISOString(),
      providers: input.providers,
    };
    const last = match.conflicts[match.conflicts.length - 1];
    if (last && last.detail === record.detail) return last;
    match.conflicts.push(record);
    if (match.conflicts.length > 20) match.conflicts.shift();
    this.counters.conflicts += 1;
    return record;
  }

  private publicMatch(match: StoredMatch): PublicMatch {
    const views = [...match.views.values()].sort((a, b) => b.receivedAtMs - a.receivedAtMs);
    const consensus = consensusOf(views);
    const lastEvent = match.events[match.events.length - 1] ?? null;
    const conflict = match.conflicts.length > 0 ? match.conflicts[match.conflicts.length - 1]! : null;
    return {
      matchId: match.matchId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      competition: match.competition,
      kickoff: match.kickoff,
      scoreHome: consensus.scoreHome,
      scoreAway: consensus.scoreAway,
      status: consensus.status,
      clock: consensus.clock,
      minute: consensus.minute,
      conflict: Boolean(conflict),
      conflictDetail: conflict?.detail ?? null,
      providers: views.map((v) => v.provider),
      providerViews: views.map(toPublicView),
      lastEvent,
      events: match.events.slice(-40),
    };
  }

  private pruneMatches(): void {
    if (this.matches.size <= MAX_MATCHES) return;
    const finished = [...this.matches.values()].filter((m) => {
      const status = consensusOf([...m.views.values()]).status;
      return status === "FINISHED" || status === "SCHEDULED";
    });
    finished.sort((a, b) => {
      const ar = Math.max(0, ...[...a.views.values()].map((v) => v.receivedAtMs));
      const br = Math.max(0, ...[...b.views.values()].map((v) => v.receivedAtMs));
      return ar - br;
    });
    while (this.matches.size > MAX_MATCHES && finished.length) {
      const drop = finished.shift();
      if (drop) this.matches.delete(drop.matchId);
    }
  }
}

function statusDraft(type: EventType, snap: ProviderSnapshot): DraftEvent {
  return {
    type,
    certainty: "unspecified",
    providerEventId: `${snap.providerMatchId}:${type}:${snap.status}:${snap.period ?? ""}`,
    minute: snap.minute,
    clock: snap.clock,
    period: snap.period,
    scoreHome: snap.scoreHome,
    scoreAway: snap.scoreAway,
    teamSide: null,
    player: null,
    detail: snap.rawStatus || null,
    providerEventTimestamp: null,
    sequence: snap.sequence,
  };
}

function consensusOf(views: StoredView[]): {
  scoreHome: number | null;
  scoreAway: number | null;
  status: CanonicalStatus;
  clock: string | null;
  minute: number | null;
} {
  if (views.length === 0) {
    return { scoreHome: null, scoreAway: null, status: "UNKNOWN", clock: null, minute: null };
  }
  const scored = views.filter((v) => v.scoreHome !== null && v.scoreAway !== null);
  const scoresAgree =
    scored.length > 0 &&
    scored.every((v) => v.scoreHome === scored[0]!.scoreHome && v.scoreAway === scored[0]!.scoreAway);
  const newest = views[0]!;
  const scoreSource = scoresAgree ? scored[0]! : newest;
  const inPlay = views.find((v) => v.status === "IN_PLAY");
  const status = inPlay?.status ?? newest.status;
  const clockSource = inPlay ?? newest;
  return {
    scoreHome: scoreSource.scoreHome,
    scoreAway: scoreSource.scoreAway,
    status,
    clock: clockSource.clock,
    minute: clockSource.minute,
  };
}

function toPublicView(v: StoredView): ProviderViewPublic {
  return {
    provider: v.provider,
    providerMatchId: v.providerMatchId,
    scoreHome: v.scoreHome,
    scoreAway: v.scoreAway,
    status: v.status,
    clock: v.clock,
    minute: v.minute,
    receivedAt: new Date(v.receivedAtMs).toISOString(),
    sequence: v.sequence,
  };
}

function sortMatches(a: PublicMatch, b: PublicMatch): number {
  const rank = (s: CanonicalStatus) => (s === "IN_PLAY" ? 0 : s === "HALFTIME" ? 1 : s === "SCHEDULED" ? 2 : 3);
  const d = rank(a.status) - rank(b.status);
  if (d !== 0) return d;
  return a.homeTeam.localeCompare(b.homeTeam);
}

function roundMs(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function hashTail(receivedAtMs: number, type: string): string {
  return (receivedAtMs % 1_000_000).toString(36) + type.slice(0, 2);
}

export { backoffMs };
