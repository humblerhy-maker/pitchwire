import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitEventName, suspensionsFromStreamObject } from "./betfair.ts";

describe("betfair stream parser", () => {
  it("keeps an in-play Goal suspension and ignores the rest", () => {
    const message = {
      op: "mcm",
      pt: 1_700_000_000_000,
      mc: [
        { id: "1.1", marketDefinition: { status: "SUSPENDED", inPlay: false, suspendReason: "Goal" } },
        { id: "1.2", marketDefinition: { status: "SUSPENDED", inPlay: true, suspendReason: "Scout Unavailable" } },
        { id: "1.3", marketDefinition: { status: "OPEN", inPlay: true, suspendReason: "Goal" } },
        { id: "1.4", marketDefinition: { status: "SUSPENDED", inPlay: true, suspendReason: " Goal " } },
        { id: "1.5", marketDefinition: { status: "SUSPENDED", inPlay: true, suspendReason: "Third Party Unavailable" } },
      ],
    };
    const hits = suspensionsFromStreamObject(message);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.marketId, "1.4");
    assert.equal(hits[0]?.reason, "Goal");
    assert.equal(hits[0]?.pt, 1_700_000_000_000);
  });

  it("splits only on the betfair v separator", () => {
    assert.deepEqual(splitEventName("Arsenal v Chelsea"), { home: "Arsenal", away: "Chelsea" });
    assert.equal(splitEventName("Arsenal vs Chelsea"), null);
    assert.equal(splitEventName("A v B v C"), null);
    assert.equal(splitEventName("Arsenal"), null);
  });
});
