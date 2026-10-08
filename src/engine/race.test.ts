import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEngine } from "./engine.ts";
import type { DraftEvent, ProviderSnapshot } from "./model.ts";

function meta(receivedAtMs: number) {
  return { receivedAtMs, receivedMono: receivedAtMs / 10, parsedAtMs: receivedAtMs + 2, mode: "live" as const };
}

function snap(partial: Partial<ProviderSnapshot> & Pick<ProviderSnapshot, "provider">): ProviderSnapshot {
  return {
    providerMatchId: "1",
    home: "Arsenal",
    away: "Chelsea",
    homeId: "arsenal",
    awayId: "chelsea",
    kickoff: "2026-10-06T19:00:00Z",
    competition: "Friendly",
    scoreHome: 0,
    scoreAway: 0,
    status: "IN_PLAY",
    rawStatus: "IN_PLAY",
    clock: "12'",
    minute: 12,
    period: 1,
    sequence: null,
    events: [],
    ...partial,
  };
}

function goal(id: string): DraftEvent {
  return {
    type: "GOAL",
    certainty: "unspecified",
    providerEventId: id,
    minute: 12,
    clock: "12'",
    period: 1,
    scoreHome: 1,
    scoreAway: 0,
    teamSide: "home",
    player: "A",
    detail: null,
    providerEventTimestamp: null,
    sequence: null,
  };
}

function suspension(id: string, pt: number): DraftEvent {
  return {
    type: "PROVISIONAL_GOAL",
    certainty: "provisional",
    providerEventId: id,
    minute: null,
    clock: null,
    period: null,
    scoreHome: null,
    scoreAway: null,
    teamSide: null,
    player: null,
    detail: "suspension",
    providerEventTimestamp: null,
    providerPublicationTimestamp: new Date(pt).toISOString(),
    sequence: pt,
  };
}

describe("source race", () => {
  it("does not add a second observation when the same provider repeats a goal", () => {
    const engine = new EventEngine();
    engine.ingest([snap({ provider: "espn" })], meta(1_000));
    engine.ingest([snap({ provider: "espn", scoreHome: 1, events: [goal("g1")] })], meta(5_000));
    const again = engine.ingest([snap({ provider: "espn", scoreHome: 1, events: [goal("g1")] })], meta(8_000));
    assert.equal(again.published.filter((event) => event.type === "GOAL").length, 0);
    const match = engine.listMatches()[0];
    const row = match?.events.find((event) => event.type === "GOAL");
    assert.equal(row?.observations.length, 1);
    assert.equal(row?.observations[0]?.provider, "espn");
  });

  it("calls no advantage when the baseline receipt is not later", () => {
    const engine = new EventEngine();
    engine.ingest([snap({ provider: "espn" })], meta(1_000));
    engine.ingest([snap({ provider: "openligadb" })], meta(1_100));
    engine.ingest([snap({ provider: "espn", scoreHome: 1, events: [goal("e")] })], meta(5_000));
    engine.ingest([snap({ provider: "openligadb", scoreHome: 1, events: [goal("o")] })], meta(8_000));
    const race = engine.sourceRaces(9_000).find((row) => row.type === "GOAL");
    assert.ok(race);
    assert.equal(race.verdict, "NO OBSERVED ADVANTAGE");
    assert.equal(race.advantageVsBaselineMs, 0);
    assert.equal(race.fastestProvider, "espn");
  });

  it("records the exact receipt delta when the other source was already watching", () => {
    const engine = new EventEngine();
    engine.ingest([snap({ provider: "espn" })], meta(1_000));
    engine.ingest([snap({ provider: "openligadb" })], meta(1_100));
    engine.ingest([snap({ provider: "openligadb", scoreHome: 1, events: [goal("o")] })], meta(4_000));
    engine.ingest([snap({ provider: "espn", scoreHome: 1, events: [goal("e")] })], meta(7_000));
    const race = engine.sourceRaces(8_000).find((row) => row.type === "GOAL");
    assert.ok(race);
    assert.equal(race.verdict, "OBSERVED ADVANTAGE");
    assert.equal(race.fastestProvider, "openligadb");
    assert.equal(race.advantageVsBaselineMs, 3_000);
    assert.equal(race.rows.find((row) => row.provider === "espn")?.providerEventTimestamp, null);
  });

  it("pairs a betfair suspension with a later espn goal inside the window only", () => {
    const inside = new EventEngine();
    inside.ingest([snap({ provider: "espn" })], meta(1_000_000));
    inside.ingest([snap({ provider: "betfair", scoreHome: null, scoreAway: null })], meta(1_001_000));
    inside.ingest(
      [
        snap({
          provider: "betfair",
          scoreHome: null,
          scoreAway: null,
          events: [suspension("m1", 1_010_000)],
          receivedAtMs: 1_010_000,
        }),
      ],
      meta(1_010_000),
    );
    const waiting = inside.sourceRaces(1_020_000).find((row) => row.method === "suspension-paired");
    assert.equal(waiting?.verdict, "BASELINE HAS NOT REPORTED");
    assert.equal(waiting?.advantageVsBaselineMs, null);

    inside.ingest([snap({ provider: "espn", scoreHome: 1, events: [goal("e")] })], meta(1_020_000));
    const paired = inside.sourceRaces(1_021_000).find((row) => row.method === "suspension-paired");
    assert.equal(paired?.verdict, "OBSERVED ADVANTAGE");
    assert.equal(paired?.advantageVsBaselineMs, 10_000);
    assert.equal(paired?.fastestProvider, "betfair");
    assert.equal(paired?.rows.find((row) => row.provider === "betfair")?.providerEventTimestamp, null);
    assert.ok(paired?.rows.find((row) => row.provider === "betfair")?.providerPublicationTimestamp);

    const late = new EventEngine();
    late.ingest([snap({ provider: "espn" })], meta(1_000_000));
    late.ingest([snap({ provider: "betfair", scoreHome: null, scoreAway: null })], meta(1_001_000));
    late.ingest(
      [
        snap({
          provider: "betfair",
          scoreHome: null,
          scoreAway: null,
          events: [suspension("m2", 1_010_000)],
          receivedAtMs: 1_010_000,
        }),
      ],
      meta(1_010_000),
    );
    late.ingest([snap({ provider: "espn", scoreHome: 1, events: [goal("late")] })], meta(1_010_000 + 300_001));
    const unpaired = late.sourceRaces(1_010_000 + 301_000).find((row) => row.method === "suspension-paired");
    assert.equal(unpaired?.verdict, "UNPAIRED");
    assert.equal(unpaired?.advantageVsBaselineMs, null);
  });
});
