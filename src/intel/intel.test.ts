import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSlip, decide } from "./decide.ts";
import { eventInWindow, parseFinderIntent } from "./intent.ts";
import { goalPair, passesGoalScreen, profilesFromLastFive, totalStrength } from "./screen.ts";
import { americanToDecimal, impliedFromDecimal, noVig, overround } from "./odds-math.ts";
import { eventsFromEspnScoreboard, quotesFromEspnOdds } from "./quotes.ts";
import { settleSelection } from "./settle.ts";
import { injuryFact, lookupTeam, parseEspnInjuryBoard } from "./injuries.ts";
import { acceptModelPicks, evidenceScore } from "./reason.ts";
import { scoringFact, scoringFromLastFive, verificationStatus } from "./summary.ts";
import { parsePicks } from "./verify.ts";
import type { Quote } from "./quotes.ts";

const oneX: Quote = {
  market: "h2h",
  selection: "Home FC",
  line: null,
  decimal: 1.8,
  american: -125,
  implied: 0.5556,
  bookmaker: "1xBet",
  is1xBet: true,
  source: "the-odds-api",
  providerTimestamp: "2026-10-07T12:00:00Z",
  openDecimal: 1.9,
  note: "test",
};

describe("intelligence", () => {
  it("converts american prices without treating them as probabilities", () => {
    const decimal = americanToDecimal(-165);
    assert.ok(decimal && Math.abs(decimal - (1 + 100 / 165)) < 1e-9);
    const implied = impliedFromDecimal(decimal!)!;
    assert.ok(implied > 0.6 && implied < 0.7);
    assert.ok((overround([0.6, 0.5]) ?? 0) > 0);
    assert.equal(noVig([0.6, 0.5], 0), 0.6 / 1.1);
  });

  it("reads a football over 1.5 request as five strongest, not a certainty", () => {
    const intent = parseFinderIntent("I need 5 sure over 1.5 games");
    assert.deepEqual(intent.sports, ["football"]);
    assert.equal(intent.count, 5);
    assert.equal(intent.line, 1.5);
    assert.equal(intent.side, "over");
    assert.equal(intent.window, "today");
    assert.equal(intent.combinedTarget, null);
    const tomorrow = parseFinderIntent("I need 3 over 1.5 games tomorrow");
    assert.equal(tomorrow.window, "tomorrow");
    assert.equal(tomorrow.count, 3);
    const both = parseFinderIntent("I need strongest football and basketball markets today");
    assert.deepEqual(both.sports, ["football", "basketball"]);
    assert.equal(both.line, null);
    const ten = parseFinderIntent("I need 10 over 1.5 games today");
    assert.equal(ten.count, 10);
    assert.equal(ten.line, 1.5);
    assert.equal(ten.window, "today");
    assert.deepEqual(ten.sports, ["football"]);
    const top = parseFinderIntent("I need 3 strongest football games today");
    assert.equal(top.count, 3);
    assert.deepEqual(top.sports, ["football"]);
    assert.equal(top.line, null);
    assert.equal(top.window, "today");
  });

  it("keeps a 23:00Z kickoff on the next Lagos day", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    assert.equal(eventInWindow("2026-10-07T20:00:00Z", "pre", "today", now), true);
    assert.equal(eventInWindow("2026-10-07T23:00:00Z", "pre", "today", now), false);
    assert.equal(eventInWindow("2026-10-07T23:00:00Z", "pre", "tomorrow", now), true);
  });

  it("reads combined odds without treating the number as a goal line", () => {
    const intent = parseFinderIntent("I need safe 3 odds basketball games");
    assert.equal(intent.combinedTarget, 3);
    assert.deepEqual(intent.sports, ["basketball"]);
    assert.equal(intent.line, null);
    const both = parseFinderIntent("Give me 3 selections around 5.00 total odds");
    assert.equal(both.count, 3);
    assert.equal(both.combinedTarget, 5);
    assert.equal(both.sports, "any");
    assert.equal(both.marketHint, null);
  });

  it("does not treat a short price or a one-sided sample as a pass", () => {
    const open = totalStrength({ games: 5, overRate: 0.8, combinedPerGame: 3.1, decimal: 1.9 });
    const chalk = totalStrength({ games: 5, overRate: 0.8, combinedPerGame: 3.1, decimal: 1.2 });
    assert.ok(open > chalk);
    assert.equal(passesGoalScreen({ strength: open, games: 5, overRate: 0.8, weakSide: 0.6 }), true);
    assert.equal(passesGoalScreen({ strength: open, games: 3, overRate: 1, weakSide: 1 }), false);
    assert.equal(passesGoalScreen({ strength: open, games: 5, overRate: 0.8, weakSide: 0.2 }), false);
    const profiles = profilesFromLastFive([
      {
        team: { id: "1", displayName: "Home FC" },
        events: [
          { homeTeamId: "1", homeTeamScore: "2", awayTeamScore: "1" },
          { homeTeamId: "9", homeTeamScore: "0", awayTeamScore: "2" },
          { homeTeamId: "1", homeTeamScore: "1", awayTeamScore: "1" },
          { homeTeamId: "1", homeTeamScore: "3", awayTeamScore: "0" },
        ],
      },
      {
        team: { id: "2", displayName: "Away FC" },
        events: [
          { homeTeamId: "2", homeTeamScore: "1", awayTeamScore: "1" },
          { homeTeamId: "2", homeTeamScore: "2", awayTeamScore: "2" },
          { homeTeamId: "8", homeTeamScore: "0", awayTeamScore: "1" },
          { homeTeamId: "2", homeTeamScore: "0", awayTeamScore: "0" },
        ],
      },
    ]);
    const pair = goalPair(profiles[0]!, profiles[1]!, 1.5, null);
    assert.ok(pair);
    assert.equal(pair!.games, 4);
    assert.ok(pair!.overRate > 0.5);
  });

  it("parses a DraftKings scoreboard price and does not call it 1xBet", () => {
    const events = eventsFromEspnScoreboard(
      {
        leagues: [{ abbreviation: "NBA" }],
        events: [
          {
            id: "1",
            date: "2026-10-07T23:00:00Z",
            status: { type: { state: "pre", shortDetail: "7:00 PM" } },
            competitions: [
              {
                competitors: [
                  { homeAway: "home", score: "0", team: { displayName: "Indiana Pacers" }, records: [{ summary: "0-0" }] },
                  { homeAway: "away", score: "0", team: { displayName: "Minnesota Timberwolves" }, records: [{ summary: "1-0" }] },
                ],
                odds: [
                  {
                    provider: { name: "DraftKings", displayName: "DraftKings" },
                    moneyline: {
                      home: { close: { odds: "+124" }, open: { odds: "+110" } },
                      away: { close: { odds: "-148" }, open: { odds: "-130" } },
                    },
                    total: {
                      over: { close: { line: "o237.5", odds: "-105" } },
                      under: { close: { line: "u237.5", odds: "-115" } },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      "basketball",
      "espn-scoreboard",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.quotes.some((quote) => quote.is1xBet), false);
    assert.equal(events[0]?.quotes.find((quote) => quote.selection === "Indiana Pacers")?.bookmaker, "DraftKings");
    assert.equal(quotesFromEspnOdds([], "A", "B").length, 0);
  });

  it("does not treat a missing 1xBet price or a short price as the decision", () => {
    const noBook = decide({
      sport: "football",
      quote: { ...oneX, bookmaker: "DraftKings", is1xBet: false },
      sameMarketImplied: [0.55, 0.45],
      selectionIndex: 0,
      recordA: "40-20",
      recordB: "30-30",
      marketHint: null,
      feeds: { injuries: false, oneXBet: false, scoringRates: false },
    });
    assert.equal(noBook.decision, "eligible");
    assert.equal(noBook.gaps.some((gap) => /1xBet/.test(gap)), false);
    const corners = decide({
      sport: "football",
      quote: oneX,
      sameMarketImplied: [0.55, 0.45],
      selectionIndex: 0,
      recordA: "40-20",
      recordB: "30-30",
      marketHint: "corners",
      feeds: { injuries: true, oneXBet: true, scoringRates: true },
    });
    assert.equal(corners.decision, "withheld");
    const chalk = evidenceScore({ decimal: 1.1, marketMatches: true, injuryKnown: false, sampleGames: 0, live: false });
    const researched = evidenceScore({ decimal: 2.1, marketMatches: true, injuryKnown: true, sampleGames: 5, live: false });
    assert.ok(researched > chalk);
    const accepted = acceptModelPicks(
      ['{"issued":[{"id":"real","reason":"packet only"},{"id":"invented","reason":"no"}]}', "not json"],
      new Set(["real"]),
    );
    assert.deepEqual(accepted.ids, ["real"]);
    assert.deepEqual(accepted.invented, ["invented"]);
    assert.deepEqual(acceptModelPicks(["no braces here"], new Set(["real"])).ids, []);
  });

  it("does not pad a slip with withheld prices", () => {
    const slip = buildSlip(
      [
        { id: "a", decimal: 1.5, issued: true },
        { id: "b", decimal: 1.4, issued: false },
      ],
      3,
      2,
    );
    assert.deepEqual(slip.ids, ["a"]);
    assert.match(slip.note, /not filled/i);
    assert.equal(slip.ids.includes("b"), false);
  });

  it("parses an outside pick and settles only from a final score", () => {
    const [pick] = parsePicks("Alianza FC Panama vs Independiente — Over 1.5");
    assert.equal(pick?.market, "total");
    assert.equal(pick?.line, 1.5);
    assert.equal(pick?.selection, "Over");
    assert.equal(
      settleSelection({
        market: "total",
        selection: "Over",
        line: 1.5,
        home: "Alianza",
        away: "Independiente",
        scoreHome: 2,
        scoreAway: 0,
        final: true,
      }).outcome,
      "won",
    );
    assert.equal(
      settleSelection({
        market: "h2h",
        selection: "Home",
        line: null,
        home: "Home",
        away: "Away",
        scoreHome: null,
        scoreAway: null,
        final: true,
      }).outcome,
      "pending",
    );
  });

  it("reads injury boards, pitchers, and last-five scores only from the payload", () => {
    const board = parseEspnInjuryBoard({
      injuries: [
        {
          displayName: "Indiana Pacers",
          injuries: [{ athlete: { displayName: "Tyrese Haliburton" }, status: "Out", details: { detail: "Achilles" } }],
        },
      ],
    });
    assert.ok(board);
    assert.match(injuryFact("Indiana Pacers", lookupTeam(board, "Indiana Pacers").rows), /Haliburton/);
    assert.equal(parseEspnInjuryBoard({ injuries: [] })?.length, 0);

    const events = eventsFromEspnScoreboard(
      {
        events: [
          {
            id: "9",
            date: "2026-10-07T23:00:00Z",
            season: { slug: "2026-regular-season" },
            status: { type: { state: "pre" } },
            competitions: [
              {
                competitors: [
                  {
                    homeAway: "home",
                    team: { displayName: "Chicago White Sox" },
                    probables: [{ name: "probableStartingPitcher", athlete: { displayName: "Sean Newcomb" } }],
                  },
                  {
                    homeAway: "away",
                    team: { displayName: "New York Yankees" },
                    probables: [{ name: "probableStartingPitcher", athlete: { displayName: "Someone Else" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
      "baseball",
      "espn-scoreboard",
    );
    assert.equal(events[0]?.pitcherHome, "Sean Newcomb");
    assert.equal(events[0]?.pitcherAway, "Someone Else");
    assert.equal(events[0]?.competition, "2026 regular season");

    const basketball = decide({
      sport: "basketball",
      quote: oneX,
      sameMarketImplied: [0.55, 0.45],
      selectionIndex: 0,
      recordA: "40-20",
      recordB: "30-30",
      marketHint: null,
      feeds: { injuries: true, oneXBet: true, scoringRates: true },
    });
    assert.equal(basketball.decision, "eligible");
    assert.match(basketball.gaps.join(" "), /Rest/);

    const baseball = decide({
      sport: "baseball",
      quote: oneX,
      sameMarketImplied: [0.55, 0.45],
      selectionIndex: 0,
      recordA: "40-20",
      recordB: "30-30",
      marketHint: null,
      feeds: { injuries: true, oneXBet: true, scoringRates: false, pitcherKnown: true },
      pitcherNote: "Probable pitchers on the scoreboard: Someone Else and Sean Newcomb.",
    });
    assert.equal(baseball.decision, "eligible");

    const samples = scoringFromLastFive([
      {
        team: { id: "1", displayName: "A" },
        events: [
          { homeTeamId: "1", homeTeamScore: "2", awayTeamScore: "0" },
          { homeTeamId: "9", homeTeamScore: "1", awayTeamScore: "1" },
          { homeTeamId: "1", homeTeamScore: "0", awayTeamScore: "3" },
        ],
      },
      {
        team: { id: "2", displayName: "B" },
        events: [
          { homeTeamId: "2", homeTeamScore: "1", awayTeamScore: "0" },
          { homeTeamId: "2", homeTeamScore: "1", awayTeamScore: "0" },
          { homeTeamId: "8", homeTeamScore: "0", awayTeamScore: "2" },
        ],
      },
    ]);
    assert.match(scoringFact(samples) ?? "", /A last 3: 3 scored, 4 conceded/);
    assert.equal(
      verificationStatus({ eventFound: true, sameSide: true, lineMatched: false, issued: false, oppositeIssued: false }),
      "LINE DIFFERENT",
    );
    assert.equal(
      verificationStatus({ eventFound: true, sameSide: true, lineMatched: true, issued: false, oppositeIssued: true }),
      "DISAGREEMENT",
    );
  });
});
