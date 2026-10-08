import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapShort, normalizeApiFootball } from "./apifootball.ts";
import { demoSnapshot } from "./demo.ts";
import { normalizeOpenLiga } from "./openligadb.ts";
import { normalizeSportmonks } from "./sportmonks.ts";

describe("provider normalizers", () => {
  it("parses an OpenLigaDB goal using swagger fields and does not invent a kickoff score", () => {
    const scheduled = normalizeOpenLiga([
      {
        matchID: 1,
        matchDateTimeUTC: "2099-10-09T18:30:00Z",
        leagueName: "1. Fußball-Bundesliga",
        matchIsFinished: false,
        team1: { teamId: 7, teamName: "Borussia Dortmund" },
        team2: { teamId: 8, teamName: "SV Werder Bremen" },
        matchResults: [],
        goals: [],
      },
    ]);
    assert.equal(scheduled.snapshots[0]?.status, "SCHEDULED");
    assert.equal(scheduled.snapshots[0]?.scoreHome, null);
    assert.equal(scheduled.snapshots[0]?.events.length, 0);

    const live = normalizeOpenLiga([
      {
        matchID: 2,
        matchDateTimeUTC: "2026-10-06T16:00:00",
        leagueName: "Testliga",
        matchIsFinished: false,
        lastUpdateDateTime: "2026-10-06T16:20:00",
        team1: { teamId: 1, teamName: "Alpha" },
        team2: { teamId: 2, teamName: "Beta" },
        matchResults: [{ resultOrderID: 1, pointsTeam1: 1, pointsTeam2: 0, resultName: "Zwischenstand" }],
        goals: [
          {
            goalID: 99,
            scoreTeam1: 1,
            scoreTeam2: 0,
            matchMinute: 14,
            goalGetterName: "A. Striker",
            scoringTeamId: 1,
            isPenalty: false,
            isOwnGoal: false,
            isOvertime: false,
          },
        ],
      },
    ]);
    assert.equal(live.snapshots[0]?.status, "IN_PLAY");
    assert.equal(live.snapshots[0]?.events[0]?.type, "GOAL");
    assert.equal(live.snapshots[0]?.events[0]?.providerEventId, "99");
    assert.equal(live.snapshots[0]?.events[0]?.providerEventTimestamp, null);
    assert.equal(live.snapshots[0]?.scoreHome, 1);
  });

  it("maps API-Football status codes from the published table and goal details", () => {
    assert.equal(mapShort("1H"), "IN_PLAY");
    assert.equal(mapShort("HT"), "HALFTIME");
    assert.equal(mapShort("FT"), "FINISHED");
    assert.equal(mapShort("PST"), "POSTPONED");
    assert.equal(mapShort("SUSP"), "SUSPENDED");
    const { snapshots } = normalizeApiFootball({
      response: [
        {
          fixture: { id: 10, date: "2026-10-06T16:00:00+00:00", timestamp: 100, status: { short: "1H", elapsed: 22 } },
          league: { name: "Premier League" },
          teams: { home: { id: 1, name: "Arsenal" }, away: { id: 2, name: "Chelsea" } },
          goals: { home: 1, away: 0 },
          events: [
            { time: { elapsed: 22, extra: null }, team: { id: 1 }, player: { name: "Saka" }, type: "Goal", detail: "Normal Goal" },
            { time: { elapsed: 40 }, team: { id: 2 }, player: { name: "James" }, type: "Card", detail: "Yellow Card" },
            { time: { elapsed: 50 }, team: { id: 1 }, player: { name: "X" }, type: "Var", detail: "Goal cancelled" },
          ],
        },
      ],
    });
    assert.equal(snapshots[0]?.events[0]?.type, "GOAL");
    assert.equal(snapshots[0]?.events[1]?.type, "YELLOW_CARD");
    assert.equal(snapshots[0]?.events[2]?.type, "CANCELLED_GOAL");
    assert.equal(snapshots[0]?.events[2]?.certainty, "cancelled");
  });

  it("maps Sportmonks type ids and CURRENT scores from the documented include", () => {
    const { snapshots, malformed } = normalizeSportmonks({
      data: [
        {
          id: 55,
          starting_at: "2026-10-06 16:00:00",
          state: { developer_name: "INPLAY_1ST_HALF" },
          participants: [
            { id: 9, name: "FC Copenhagen", meta: { location: "home" } },
            { id: 8, name: "Celtic", meta: { location: "away" } },
          ],
          scores: [
            { description: "CURRENT", score: { goals: 1, participant: "home" } },
            { description: "CURRENT", score: { goals: 0, participant: "away" } },
          ],
          events: [
            { id: 7, type_id: 14, minute: 18, player_name: "A. Player", participant_id: 9, result: "1-0", sort_order: 3 },
            { id: 8, type_id: 19, minute: 30, player_name: "B. Player", participant_id: 8 },
            { id: 9, type_id: 10, sub_type_id: 1512, minute: 40, player_name: "C", participant_id: 9 },
          ],
        },
      ],
    });
    assert.equal(malformed, 0);
    assert.equal(snapshots[0]?.kickoff, "2026-10-06T16:00:00Z");
    assert.equal(snapshots[0]?.status, "IN_PLAY");
    assert.equal(snapshots[0]?.scoreHome, 1);
    assert.equal(snapshots[0]?.events.map((e) => e.type).join(","), "GOAL,YELLOW_CARD,CANCELLED_GOAL");
    assert.equal(snapshots[0]?.events[2]?.certainty, "cancelled");
  });

  it("plays the demo script in order and stays fictional", () => {
    const start = demoSnapshot(0);
    const goal = demoSnapshot(4000);
    const done = demoSnapshot(23000);
    assert.equal(start.status, "SCHEDULED");
    assert.equal(goal.events[0]?.player, "A. Okonkwo");
    assert.equal(goal.scoreHome, 1);
    assert.equal(done.status, "FINISHED");
    assert.equal(goal.home, "Harbour FC");
  });
});
