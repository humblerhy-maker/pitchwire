import { decide, buildSlip } from "./decide.ts";
import { eventInWindow, parseFinderIntent, type FinderIntent, type SportId } from "./intent.ts";
import { loadInjuryContext } from "./injuries.server.ts";
import { anyModelConfigured, reasonOnPacket, type ModelNote } from "./llm.server.ts";
import { calibration, saveRun, settlePending, type StoredPrediction } from "./ledger.server.ts";
import { loadOneXBetEvents, oddsGroupsFor } from "./odds-api.server.ts";
import { eventKey, eventsFromEspnScoreboard, mergeEvents, type ParsedEvent, type Quote } from "./quotes.ts";
import { acceptModelPicks, evidenceScore } from "./reason.ts";
import { scoringFact, scoringFromLastFive, verificationStatus } from "./summary.ts";
import { namesMatch, parsePicks, type ParsedPick } from "./verify.ts";
import { profilesFromLastFive, goalPair, passesGoalScreen, strengthLabel, totalStrength, type GoalSample } from "./screen.ts";
import { loadUniverse, type UniverseDiag } from "./universe.server.ts";

const BOARDS: Array<[string, string]> = [
  ["football", "https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard"],
  ["basketball", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"],
  ["baseball", "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"],
  ["hockey", "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard"],
];

let boardCache: { at: number; events: ParsedEvent[]; errors: string[] } | null = null;

export interface PublicCandidate {
  id: string;
  sport: string;
  competition: string | null;
  home: string;
  away: string;
  start: string | null;
  state: string;
  clock: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  market: string;
  selection: string;
  line: number | null;
  bookmaker: string;
  is1xBet: boolean;
  decimal: number;
  providerTimestamp: string | null;
  decision: "issued" | "withheld";
  eligible: boolean;
  reasons: string[];
  gaps: string[];
  checks: string[];
  modelProbability: number | null;
  modelLabel: string | null;
  noVig: number | null;
  eventId: string;
  strength: number | null;
  overRate: number | null;
  confirm: "model" | "screen" | "none";
}

export interface FinderResult {
  intent: FinderIntent;
  scanned: Array<{ sport: string; events: number; quotes: number }>;
  oddsDetail: string;
  errors: string[];
  candidates: PublicCandidate[];
  issued: PublicCandidate[];
  combined: number | null;
  slipNote: string;
  modelNotes: ModelNote[];
  calibration: ReturnType<typeof calibration>;
  receivedAt: string;
  researchStop: string;
  injuryDetail: string;
  outsideWindow: Array<{ sport: string; events: number }>;
  blocker: string | null;
  aiCalled: boolean;
  nearby: Array<{ sport: string; home: string; away: string; start: string | null }>;
  coverage: {
    leaguesKnown: number;
    scoreboardsRead: number;
    eventsDiscovered: number;
    insideDay: number;
    outsideDay: number;
    footballInside: number;
    footballPre: number;
    basketballInside: number;
    summariesRead: number;
    screened: number;
    survivors: number;
    deepResearched: number;
    note: string;
    day: string;
  } | null;
}

async function loadBoards(intent?: FinderIntent): Promise<{ events: ParsedEvent[]; errors: string[] }> {
  if (!boardCache || Date.now() - boardCache.at >= 45_000) {
    const errors: string[] = [];
    const batches = await Promise.all(
      BOARDS.map(async ([sport, url]) => {
        try {
          const res = await fetch(url, {
            headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) {
            errors.push(`${sport} scoreboard HTTP ${res.status}`);
            return [];
          }
          return eventsFromEspnScoreboard(await res.json(), sport, "espn-scoreboard");
        } catch (err) {
          errors.push(`${sport}: ${err instanceof Error ? err.message : "failed"}`);
          return [];
        }
      }),
    );
    boardCache = { at: Date.now(), events: batches.flat(), errors };
  }
  if (!intent || !wantsExtra(intent)) return boardCache;
  const extra = await loadExtraBoards();
  return {
    events: [...boardCache.events, ...extra.events],
    errors: [...boardCache.errors, ...extra.errors],
  };
}

const EXTRA: Array<[string, string, string]> = [
  ["tennis", "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard", "ATP scoreboard is a tournament document, not a flat match list, unless home and away competitors are present."],
  ["volleyball", "https://site.api.espn.com/apis/site/v2/sports/volleyball/scoreboard", "Volleyball scoreboard is not connected."],
  ["table-tennis", "https://site.api.espn.com/apis/site/v2/sports/table-tennis/scoreboard", "Table tennis scoreboard is not connected."],
];

let extraCache: { at: number; events: ParsedEvent[]; errors: string[] } | null = null;

function wantsExtra(intent: FinderIntent): boolean {
  if (intent.sports === "any") return true;
  return intent.sports.some((sport) => sport === "tennis" || sport === "volleyball" || sport === "table-tennis");
}

async function loadExtraBoards(): Promise<{ events: ParsedEvent[]; errors: string[] }> {
  if (extraCache && Date.now() - extraCache.at < 10 * 60 * 1000) return extraCache;
  const errors: string[] = [];
  const events: ParsedEvent[] = [];
  await Promise.all(
    EXTRA.map(async ([sport, url, emptyNote]) => {
      try {
        const res = await fetch(url, {
          headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          errors.push(`${sport} scoreboard HTTP ${res.status}. ${emptyNote}`);
          return;
        }
        const raw = await res.json();
        const parsed = eventsFromEspnScoreboard(raw, sport, "espn-scoreboard");
        if (parsed.length === 0) errors.push(`${sport}: ${emptyNote} Nothing was invented.`);
        events.push(...parsed);
      } catch (err) {
        errors.push(`${sport}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }),
  );
  extraCache = { at: Date.now(), events, errors };
  return extraCache;
}

function wanted(intent: FinderIntent, sport: string): boolean {
  if (intent.sports === "any") return true;
  return intent.sports.includes(sport as SportId);
}

function toCandidate(
  event: ParsedEvent,
  quote: Quote,
  index: number,
  hint: string | null,
  injury: { known: boolean; facts: string[] },
  scoringNote: string | null,
): PublicCandidate {
  const siblings = event.quotes.filter(
    (row) => row.market === quote.market && row.bookmaker === quote.bookmaker && row.line === quote.line,
  );
  const implied = siblings.map((row) => row.implied);
  const selectionIndex = Math.max(0, siblings.findIndex((row) => row.selection === quote.selection && row.decimal === quote.decimal));
  const pitcherKnown = event.sport === "baseball" && !!event.pitcherHome && !!event.pitcherAway;
  const decision = decide({
    sport: event.sport,
    quote,
    sameMarketImplied: implied.length >= 2 ? implied : [quote.implied],
    selectionIndex: implied.length >= 2 ? selectionIndex : 0,
    recordA: quote.selection === event.away ? event.recordAway : event.recordHome,
    recordB: quote.selection === event.away ? event.recordHome : event.recordAway,
    marketHint: hint,
    feeds: {
      injuries: injury.known,
      oneXBet: quote.is1xBet,
      scoringRates: quote.market === "total" && !!scoringNote,
      pitcherKnown,
    },
    pitcherNote: pitcherKnown ? `Probable pitchers on the scoreboard: ${event.pitcherAway} and ${event.pitcherHome}.` : null,
  });
  if (injury.known) decision.checks.push(...injury.facts);
  if (scoringNote) decision.checks.push(scoringNote);
  if (event.state === "in") {
    decision.checks.push(
      `Live state is ${event.scoreHome ?? "?"}\u2013${event.scoreAway ?? "?"}${event.clock ? `, ${event.clock}` : ""}. Pre-match prices are not treated as a live model.`,
    );
  }
  return {
    id: `${event.providerEventId}:${quote.market}:${quote.selection}:${quote.line ?? "na"}:${index}`,
    sport: event.sport,
    competition: event.competition,
    home: event.home,
    away: event.away,
    start: event.start,
    state: event.state,
    clock: event.clock,
    scoreHome: event.scoreHome,
    scoreAway: event.scoreAway,
    market: quote.market,
    selection: quote.selection,
    line: quote.line,
    bookmaker: quote.bookmaker,
    is1xBet: quote.is1xBet,
    decimal: quote.decimal,
    providerTimestamp: quote.providerTimestamp,
    decision: "withheld",
    eligible: decision.decision === "eligible",
    reasons: decision.reasons,
    gaps: decision.gaps,
    checks: decision.checks,
    modelProbability: decision.modelProbability,
    modelLabel: decision.modelLabel,
    noVig: decision.noVig,
    eventId: event.providerEventId,
    strength: null,
    overRate: null,
    confirm: "none",
  };
}
