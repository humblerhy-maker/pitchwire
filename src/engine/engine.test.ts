import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEngine } from "./engine.ts";
import { backoffMs } from "./ids.ts";
import { nearestRank } from "./metrics.ts";
import type { ProviderSnapshot } from "./model.ts";
import { normalizeEspnScoreboard } from "../providers/espn.ts";
import { ESPN_SAMPLE } from "../server/sample-espn.ts";

function snap(partial: Partial<ProviderSnapshot> & Pick<ProviderSnapshot, "provider" | "home" | "away">): ProviderSnapshot {
  return {
    providerMatchId: partial.providerMatchId ?? "1",
    homeId: partial.homeId ?? "h",
    awayId: partial.awayId ?? "a",
    kickoff: partial.kickoff ?? "2026-10-06T16:00:00Z",
    competition: partial.competition ?? "Friendly",
    scoreHome: partial.scoreHome ?? 0,
    scoreAway: partial.scoreAway ?? 0,
    status: partial.status ?? "IN_PLAY",
    rawStatus: partial.rawStatus ?? "IN_PLAY",
    clock: partial.clock ?? "10'",
    minute: partial.minute ?? 10,
    period: partial.period ?? 1,
    sequence: partial.sequence ?? null,
    events: partial.events ?? [],
    ...partial,
  };
}

describe("event engine", () => {
  it("dedupes the same provider event id and keeps one goal", () => {
    const engine = new EventEngine();
    const goal = {
      type: "GOAL" as const,
      certainty: "unspecified" as const,
      providerEventId: "g1",
      minute: 10,
      clock: "10'",
      period: 1,
      scoreHome: 1,
      scoreAway: 0,
      teamSide: "home" as const,
      player: "A",
      detail: null,
      providerEventTimestamp: null,
      sequence: 1,
    };
    const base = snap({ provider: "espn", home: "Russia", away: "Nigeria", scoreHome: 1, scoreAway: 0, events: [goal] });
    const meta = { receivedAtMs: 1_000, receivedMono: 10, mode: "live" as const };
    const first = engine.ingest([base], meta);
    const second = engine.ingest([base], { ...meta, receivedAtMs: 2_000, receivedMono: 20 });
    const goals = first.published.filter((e) => e.type === "GOAL");
    assert.equal(goals.length, 1);
    assert.equal(second.published.filter((e) => e.type === "GOAL").length, 0);
    assert.ok(second.duplicates >= 1);
  });

  it("records a second provider on the same scoreline instead of a second signal", () => {
    const engine = new EventEngine();
    const event = {
      type: "GOAL" as const,
      certainty: "unspecified" as const,
      providerEventId: null,
      minute: 12,
      clock: "12'",
      period: 1,
      scoreHome: 1,
      scoreAway: 0,
      teamSide: "home" as const,
      player: "A",
      detail: null,
      providerEventTimestamp: null,
      sequence: null,
    };
    const a = snap({ provider: "espn", home: "Russia", away: "Nigeria", scoreHome: 1, events: [{ ...event, providerEventId: "e1" }] });
    const b = snap({
      provider: "openligadb",
      home: "Russia",
      away: "Nigeria",
      scoreHome: 1,
      events: [{ ...event, providerEventId: "o1", player: "A. Other" }],
    });
    engine.ingest([a], { receivedAtMs: 5_000, receivedMono: 1, mode: "live" });
    const second = engine.ingest([b], { receivedAtMs: 6_000, receivedMono: 2, mode: "live" });
    assert.equal(second.published.filter((e) => e.type === "GOAL").length, 0);
    assert.equal(second.patched.length, 1);
    assert.equal(second.patched[0]?.observations.length, 2);
    const match = engine.listMatches()[0];
    assert.ok(match);
    assert.equal(match.providers.length, 2);
    assert.equal(match.conflict, false);
  });

  it("does not hide a score conflict", () => {
    const engine = new EventEngine();
    engine.ingest([snap({ provider: "espn", home: "Russia", away: "Nigeria", scoreHome: 1, scoreAway: 0 })], {
      receivedAtMs: 10_000,
      receivedMono: 1,
      mode: "live",
    });
    const second = engine.ingest(
      [snap({ provider: "openligadb", home: "Russia", away: "Nigeria", scoreHome: 2, scoreAway: 0 })],
      { receivedAtMs: 11_000, receivedMono: 2, mode: "live" },
    );
    assert.ok(second.conflicts.length >= 1);
    const match = engine.listMatches()[0];
    assert.equal(match?.conflict, true);
    assert.match(match?.conflictDetail ?? "", /Score disagreement/);
    assert.equal(match?.providerViews.length, 2);
  });

  it("rejects an older sequence instead of rewinding the score", () => {
    const engine = new EventEngine();
    engine.ingest(
      [snap({ provider: "api-football", home: "Russia", away: "Nigeria", scoreHome: 1, scoreAway: 0, sequence: 5 })],
      { receivedAtMs: 20_000, receivedMono: 1, mode: "live" },
    );
    const stale = engine.ingest(
      [snap({ provider: "api-football", home: "Russia", away: "Nigeria", scoreHome: 0, scoreAway: 0, sequence: 4 })],
      { receivedAtMs: 21_000, receivedMono: 2, mode: "live" },
    );
    assert.equal(stale.outOfOrder, 1);
    const view = engine.listMatches()[0]?.providerViews.find((v) => v.provider === "api-football");
    assert.equal(view?.scoreHome, 1);
  });

  it("drops demo snapshots while live", () => {
    const engine = new EventEngine();
    const result = engine.ingest([snap({ provider: "demo", home: "Harbour FC", away: "Northbridge" })], {
      receivedAtMs: 1,
      receivedMono: 1,
      mode: "live",
    });
    assert.equal(result.rejectedDemo, 1);
    assert.equal(engine.listMatches().length, 0);
  });

  it("normalizes the captured ESPN payload into two goals", () => {
    const { snapshots, malformed } = normalizeEspnScoreboard(ESPN_SAMPLE);
    assert.equal(malformed, 0);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.home, "Russia");
    assert.equal(snapshots[0]?.away, "Nigeria");
    assert.equal(snapshots[0]?.status, "IN_PLAY");
    const goals = snapshots[0]?.events.filter((e) => e.type === "GOAL") ?? [];
    assert.equal(goals.length, 2);
    assert.equal(goals[0]?.player, "Kelechi Iheanacho");
    assert.equal(goals[0]?.scoreAway, 1);
    assert.equal(goals[1]?.player, "Lechii Sadulaev");
    assert.equal(goals[1]?.scoreHome, 1);
    const engine = new EventEngine();
    engine.replay = true;
    const ingested = engine.ingest(snapshots, { receivedAtMs: Date.now(), receivedMono: performance.now(), mode: "live" });
    assert.ok(ingested.published.some((e) => e.type === "GOAL" && e.player === "Kelechi Iheanacho"));
  });

  it("rejects a malformed scoreboard without throwing", () => {
    const { snapshots, malformed } = normalizeEspnScoreboard({ events: "nope" });
    assert.equal(snapshots.length, 0);
    assert.equal(malformed, 1);
    const engine = new EventEngine();
    const result = engine.ingest(
      [{ provider: "espn", home: "", away: "", providerMatchId: "", homeId: "", awayId: "", kickoff: null, competition: null, scoreHome: null, scoreAway: null, status: "UNKNOWN", rawStatus: "", clock: null, minute: null, period: null, sequence: null, events: [] }],
      { receivedAtMs: 1, receivedMono: 1, mode: "live" },
    );
    assert.equal(result.malformed, 1);
  });

  it("backs off with jitter and a 60s cap", () => {
    assert.equal(backoffMs(0, 0), 250);
    assert.equal(backoffMs(0, 0.999), 500);
    const high = backoffMs(20, 0.999);
    assert.ok(high <= 60_000);
    assert.ok(high >= 30_000);
  });

  it("computes nearest-rank percentiles from real samples", () => {
    assert.equal(nearestRank([], 50), null);
    assert.equal(nearestRank([1, 2, 3, 4], 50), 2);
    assert.equal(nearestRank([1, 2, 3, 4], 100), 4);
  });

  it("processes batches of 100, 500, 1000 and 5000 snapshots", () => {
    const report = [];
    for (const count of [100, 500, 1000, 5000]) {
      const engine = new EventEngine();
      const t0 = performance.now();
      for (let i = 0; i < count; i += 1) {
        const receivedMono = performance.now();
        engine.ingest(
          [
            snap({
              provider: "espn",
              providerMatchId: String(i),
              home: `Home ${i}`,
              away: `Away ${i}`,
              kickoff: `2026-10-06T${String(i % 24).padStart(2, "0")}:00:00Z`,
              scoreHome: 1,
              scoreAway: 0,
              events: [
                {
                  type: "GOAL",
                  certainty: "unspecified",
                  providerEventId: `g-${i}`,
                  minute: 8,
                  clock: "8'",
                  period: 1,
                  scoreHome: 1,
                  scoreAway: 0,
                  teamSide: "home",
                  player: "P",
                  detail: null,
                  providerEventTimestamp: null,
                  sequence: 1,
                },
              ],
            }),
          ],
          { receivedAtMs: 1_700_000_000_000 + i, receivedMono, mode: "live" },
        );
      }
      const elapsed = performance.now() - t0;
      const q = engine.counters.processing.quantiles();
      report.push({ matches: count, wallMs: Math.round(elapsed * 1000) / 1000, processing: q });
      assert.ok((q.p99 ?? 0) < 50);
    }
    console.log(JSON.stringify(report));
  });
});
