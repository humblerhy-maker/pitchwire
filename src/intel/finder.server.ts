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
      `Live state is ${event.scoreHome ?? "?"}–${event.scoreAway ?? "?"}${event.clock ? `, ${event.clock}` : ""}. Pre-match prices are not treated as a live model.`,
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

const profileCache = new Map<string, { at: number; home: GoalSample | null; away: GoalSample | null; fact: string | null }>();

async function loadGoalProfiles(
  events: ParsedEvent[],
  cap: number,
): Promise<{ profiles: Map<string, { home: GoalSample | null; away: GoalSample | null; fact: string | null }>; read: number; capped: boolean }> {
  const targets = events
    .filter((event) => event.sport === "football" && event.state === "pre")
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))
    .slice(0, cap);
  const notes = new Map<string, { home: GoalSample | null; away: GoalSample | null; fact: string | null }>();
  let read = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const event = targets[cursor];
      cursor += 1;
      if (!event) continue;
      const hit = profileCache.get(event.providerEventId);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
        notes.set(event.providerEventId, hit);
        read += 1;
        continue;
      }
      read += 1;
      try {
        const res = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${encodeURIComponent(event.providerEventId)}`,
          { headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" }, signal: AbortSignal.timeout(8000) },
        );
        if (!res.ok) {
          const empty = { at: Date.now(), home: null, away: null, fact: null };
          profileCache.set(event.providerEventId, empty);
          notes.set(event.providerEventId, empty);
          continue;
        }
        const body = (await res.json()) as { lastFiveGames?: unknown };
        const parsed = profilesFromLastFive(body.lastFiveGames);
        const home = parsed.find((row) => namesMatch(row.team, event.home)) ?? null;
        const away = parsed.find((row) => namesMatch(row.team, event.away)) ?? null;
        const fact = scoringFact(parsed);
        const row = { at: Date.now(), home, away, fact };
        profileCache.set(event.providerEventId, row);
        notes.set(event.providerEventId, row);
      } catch {
        const empty = { at: Date.now(), home: null, away: null, fact: null };
        profileCache.set(event.providerEventId, empty);
        notes.set(event.providerEventId, empty);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, targets.length) }, () => worker()));
  const pre = events.filter((event) => event.sport === "football" && event.state === "pre").length;
  return { profiles: notes, read, capped: pre > cap };
}

type GoalRow = PublicCandidate & { strength: number; overRate: number; games: number; weakSide: number; combined: number };

function goalRows(events: ParsedEvent[], intent: FinderIntent, profiles: Map<string, { home: GoalSample | null; away: GoalSample | null; fact: string | null }>): GoalRow[] {
  const line = intent.line ?? 1.5;
  const side = intent.side ?? "over";
  if (line > 2.5) return [];
  const rows: GoalRow[] = [];
  for (const event of events) {
    if (event.sport !== "football" || event.state !== "pre") continue;
    const profile = profiles.get(event.providerEventId);
    if (!profile?.home || !profile.away) continue;
    const quote =
      event.quotes.find((item) => item.market === "total" && item.selection.toLowerCase() === side && item.line === line) ?? null;
    const pair = goalPair(profile.home, profile.away, line, quote?.decimal ?? null);
    if (!pair) continue;
    const homeRate = side === "under" ? 1 - pair.homeRate : pair.homeRate;
    const awayRate = side === "under" ? 1 - pair.awayRate : pair.awayRate;
    const selectionRate = (homeRate + awayRate) / 2;
    const weakSide = Math.min(homeRate, awayRate);
    const strength = totalStrength({
      games: pair.games,
      overRate: selectionRate,
      combinedPerGame: pair.combined,
      decimal: quote?.decimal ?? null,
    });
    if (strength < 0) continue;
    const conflict = Math.abs(selectionRate - weakSide) >= 0.35;
    rows.push({
      id: `${event.providerEventId}:total:${side}:${line}`,
      eventId: event.providerEventId,
      sport: event.sport,
      competition: event.competition,
      home: event.home,
      away: event.away,
      start: event.start,
      state: event.state,
      clock: event.clock,
      scoreHome: event.scoreHome,
      scoreAway: event.scoreAway,
      market: "total",
      selection: side === "over" ? "Over" : "Under",
      line,
      bookmaker: quote?.bookmaker ?? "none",
      is1xBet: quote?.is1xBet ?? false,
      decimal: quote?.decimal ?? 0,
      providerTimestamp: quote?.providerTimestamp ?? null,
      decision: "withheld",
      eligible: strength >= 6,
      reasons: [
        `Recent sample ${side} ${line} is ${(selectionRate * 100).toFixed(0)}% across at least ${pair.games} games. Screen ${strength}. Not a certainty.`,
      ],
      gaps: [
        ...(quote ? [] : [`No public ${side} ${line} price was on the scoreboard. The price was not invented.`]),
        "Likely lineup, injuries, and the exact 1xBet listing were not verified.",
        ...(conflict ? [`The quieter club's recent rate is ${(weakSide * 100).toFixed(0)}%, which conflicts with treating both sides as open.`] : []),
      ],
      checks: [
        profile.fact ?? `${event.home} and ${event.away} recent scores were read.`,
        `Combined recent goals per sampled match ${pair.combined.toFixed(2)}. Clean sheets and failures to score are in the sample, not a separate model.`,
        "The sample is the last five games, not a home/away split.",
      ],
      modelProbability: null,
      modelLabel: null,
      noVig: null,
      strength,
      overRate: selectionRate,
      confirm: "none",
      games: pair.games,
      weakSide,
      combined: pair.combined,
    });
  }
  rows.sort((a, b) => b.strength - a.strength || b.weakSide - a.weakSide || b.combined - a.combined || a.home.localeCompare(b.home));
  return rows;
}

export async function runFinder(text: string): Promise<FinderResult> {
  const intent = parseFinderIntent(text);
  const receivedAt = new Date().toISOString();
  let universeDiag: UniverseDiag | null = null;
  let sourceEvents: ParsedEvent[] = [];
  let errors: string[] = [];
  if (intent.window !== "upcoming") {
    const universe = await loadUniverse(intent.window);
    universeDiag = universe.diag;
    sourceEvents = universe.events;
  } else {
    const boards = await loadBoards(intent);
    sourceEvents = boards.events;
    errors = boards.errors;
  }
  const odds = await loadOneXBetEvents(oddsGroupsFor(intent.sports));
  const merged = mergeEvents(sourceEvents, odds.events).filter((event) => wanted(intent, event.sport));
  const outside = new Map<string, number>();
  const events = merged.filter((event) => {
    const inWindow = eventInWindow(event.start, event.state, intent.window) && (!intent.liveOnly || event.state === "in");
    if (!inWindow) outside.set(event.sport, (outside.get(event.sport) ?? 0) + 1);
    return inWindow;
  });
  const injuries = await loadInjuryContext(events.map((event) => event.sport));
  const goalMode = intent.line != null && intent.side != null && (intent.sports === "any" || intent.sports.includes("football"));
  const wantGoals =
    goalMode ||
    (intent.marketHint == null && (intent.sports === "any" || intent.sports.includes("football")));
  const profilePack = await loadGoalProfiles(events, wantGoals ? 100 : 40);
  const profiles = profilePack.profiles;
  const goalCandidates = wantGoals
    ? goalRows(events, goalMode ? intent : { ...intent, line: 1.5, side: "over", marketHint: "total" }, profiles)
    : [];
  const survivors = goalCandidates.filter((row) => passesGoalScreen(row));
  const scannedMap = new Map<string, { events: number; quotes: number }>();
  const candidates: PublicCandidate[] = [];
  if (goalMode) {
    for (const row of goalCandidates) candidates.push(row);
  } else {
    for (const row of survivors) candidates.push(row);
  }
  for (const event of events) {
    const bucket = scannedMap.get(event.sport) ?? { events: 0, quotes: 0 };
    bucket.events += 1;
    bucket.quotes += event.quotes.length;
    scannedMap.set(event.sport, bucket);
    if (goalMode) continue;
    const quotes = intent.marketHint
      ? event.quotes.filter((quote) => hintAllows(intent.marketHint, quote.market))
      : event.quotes;
    const injury = injuries.forEvent(event.sport, event.home, event.away);
    const scoringNote = profiles.get(event.providerEventId)?.fact ?? null;
    for (const quote of quotes) {
      candidates.push(toCandidate(event, quote, candidates.length, intent.marketHint, injury, scoringNote));
    }
  }
  if (intent.marketHint && candidates.length === 0 && !goalMode) {
    candidates.push(emptyHint(intent.marketHint));
  }
  const ranked = candidates
    .map((row) => ({
      row,
      score:
        row.overRate != null && row.strength != null
          ? row.strength + 20
          : evidenceScore({
              decimal: row.decimal,
              marketMatches: !intent.marketHint || row.market === intent.marketHint,
              injuryKnown: row.checks.some((line) => line.startsWith("ESPN report")),
              sampleGames: row.checks.some((line) => /last \d/.test(line)) ? 5 : 0,
              live: row.state === "in",
            }),
    }))
    .sort((a, b) => b.score - a.score || a.row.home.localeCompare(b.row.home));
  const packetRows = ranked
    .map((item) => item.row)
    .filter((row) => row.eligible && row.state !== "post" && (row.overRate != null || row.decimal >= 1.3))
    .slice(0, 15);
  const footballPre = events.filter((event) => event.sport === "football" && event.state === "pre").length;
  const footballPost = events.filter((event) => event.sport === "football" && event.state === "post").length;
  let modelNotes: ModelNote[] = [];
  let aiCalled = false;
  let blocker: string | null = null;
  let screenNote = "";
  if (packetRows.length === 0) {
    blocker = goalMode
      ? `No pre-match football game inside this local day had both clubs' recent scores above the review bar. Football inside the day ${events.filter((event) => event.sport === "football").length}, not started ${footballPre}, already finished ${footballPost}. Summaries read ${profilePack.read}. Both-club samples ${goalCandidates.length}. Nothing was invented.`
      : intent.marketHint
        ? `No ${intent.marketHint} market was on the public feeds. Nothing was invented.`
        : events.length === 0
          ? "No event fell inside the requested local day. Later events were not turned into picks."
          : "No eligible priced market cleared the evidence screen. A short price was not treated as safe, and missing markets were not invented.";
  } else if (!anyModelConfigured()) {
    blocker = "AI reasoning unavailable \u2014 configure an active reasoning provider. No selection was guessed.";
  } else {
    aiCalled = true;
    const reasoned = await reasonOnPacket({
      request: intent.raw,
      count: intent.count ?? 3,
      combinedTarget: intent.combinedTarget,
      note: "Rank across this screened pool. Exact 1xBet price is absent unless bookmaker is 1xBet. Do not invent it.",
      candidates: packetRows.map((row) => ({
        id: row.id,
        event: `${row.home} vs ${row.away}`,
        competition: row.competition,
        sport: row.sport,
        start: row.start,
        state: row.state,
        market: row.market,
        selection: row.selection,
        line: row.line,
        book: row.bookmaker,
        decimal: row.decimal > 1 ? row.decimal : null,
        overRate: row.overRate,
        strength: row.strength,
        games: "games" in row ? (row as GoalRow).games : null,
        weakSide: "weakSide" in row ? (row as GoalRow).weakSide : null,
        observed: row.checks.slice(0, 4),
        uncertainties: row.gaps.slice(0, 3),
      })),
    });
    modelNotes = reasoned.notes;
    const accepted = acceptModelPicks(reasoned.texts, new Set(packetRows.map((row) => row.id)));
    const limit = intent.count ?? 3;
    if (goalMode) {
      const modelSurvivors = survivors.filter((row) => accepted.ids.includes(row.id));
      const chosen = [...modelSurvivors, ...survivors.filter((row) => !accepted.ids.includes(row.id))].slice(0, limit);
      for (const row of chosen.slice(0, limit)) {
        const confirmed = modelSurvivors.some((item) => item.id === row.id);
        row.decision = "issued";
        row.confirm = confirmed ? "model" : "screen";
        row.modelLabel = strengthLabel(row.strength, confirmed);
        if (confirmed && accepted.reasons[row.id]) row.reasons = [accepted.reasons[row.id]];
        else if (!confirmed) {
          row.reasons = [
            `Recent scores clear the screen (${(row.overRate * 100).toFixed(0)}% over, screen ${row.strength}). The model did not confirm this id. This is not a certainty.`,
          ];
        }
      }
      if (chosen.length === 0) {
        blocker = `Discovery found football inside this local day, but none cleared the evidence bar (at least 4 games, both clubs, over rate at least 60%, screen at least 8). Screened ${goalCandidates.length}. Sent for review ${packetRows.length}. Already finished ${footballPost}. The count was not filled with weaker matches.`;
      } else if (modelSurvivors.length < chosen.length) {
        screenNote = reasoned.texts.length
          ? " Some selections cleared the recent-score screen without a model confirmation. They are not a certificate, and weaker matches were not added to fill the count."
          : " The model returned no usable text. These are the strongest that cleared the recent-score screen, not a guess filled in to hit the count.";
      }
    } else {
      const pool = ranked.filter((item) => {
        if (item.row.state === "post" || item.row.eventId === "none") return false;
        if (item.row.overRate != null) return passesGoalScreen(item.row as GoalRow);
        return item.row.eligible && item.row.decimal >= 1.4 && item.score >= 7;
      });
      const seen = new Set<string>();
      const unique: typeof pool = [];
      for (const item of pool) {
        if (seen.has(item.row.eventId)) continue;
        if (item.row.overRate == null) {
          const siblings = pool.filter(
            (other) => other.row.eventId === item.row.eventId && other.row.market === item.row.market && other.row.line === item.row.line,
          );
          const best = Math.max(...siblings.map((other) => other.score));
          if (siblings.filter((other) => best - other.score < 0.05).length > 1) continue;
        }
        seen.add(item.row.eventId);
        unique.push(item);
      }
      const modelPassers = unique.filter((item) => accepted.ids.includes(item.row.id));
      const rest = unique.filter((item) => !accepted.ids.includes(item.row.id));
      const ordered = [...modelPassers, ...rest];
      const mixed: typeof ordered = [];
      const used = new Set<string>();
      if (Array.isArray(intent.sports) && intent.sports.length > 1) {
        for (const sport of intent.sports) {
          const next = ordered.find((item) => item.row.sport === sport && !used.has(item.row.id));
          if (!next) continue;
          mixed.push(next);
          used.add(next.row.id);
        }
      }
      for (const item of ordered) {
        if (mixed.length >= limit) break;
        if (used.has(item.row.id)) continue;
        mixed.push(item);
        used.add(item.row.id);
      }
      const chosen = mixed.slice(0, limit);
      for (const item of chosen.slice(0, limit)) {
        const confirmed = modelPassers.some((row) => row.row.id === item.row.id);
        item.row.decision = "issued";
        item.row.confirm = confirmed ? "model" : "screen";
        item.row.modelLabel = confirmed ? "Strongest available" : "Screened, not model-confirmed";
        if (confirmed && accepted.reasons[item.row.id]) item.row.reasons = [accepted.reasons[item.row.id]];
        else if (!confirmed) {
          item.row.reasons = [
            "This priced market ranked on the public evidence we actually have. The model did not confirm the id. A short price was not treated as safety.",
          ];
        }
      }
      if (chosen.length === 0) {
        blocker = `The local-day slate was read. ${packetRows.length} priced markets were reviewed. None cleared the evidence bar, so the list was not filled.`;
      } else if (modelPassers.length < chosen.length) {
        screenNote = " Some markets were not confirmed by the model. They still cleared the public evidence bar. Weaker prices were not added.";
      }
    }
  }
  const issued = candidates.filter((row) => row.decision === "issued");
  const slip = buildSlip(
    issued.map((row) => ({ id: row.id, decimal: row.decimal, issued: true })),
    intent.combinedTarget,
    intent.count,
  );
  const slipRows = issued.filter((row) => slip.ids.includes(row.id));
  if (Array.isArray(intent.sports)) {
    const quiet = intent.sports.filter(
      (sport) => events.some((event) => event.sport === sport) && !slipRows.some((row) => row.sport === sport),
    );
    if (quiet.length) {
      screenNote += ` ${quiet.join(" and ")} had events inside this local day, but none of those events had a market that cleared. Nothing was invented for them.`;
    }
  }
  const shown = [...slipRows, ...ranked.map((item) => item.row).filter((row) => row.decision !== "issued")].slice(0, 8);
  const researchStop = universeDiag
    ? universeDiag.note
    : "This request used the short upcoming window, not the full local-day league sweep.";
  const nearby = merged
    .filter((event) => !events.includes(event))
    .slice(0, 5)
    .map((event) => ({ sport: event.sport, home: event.home, away: event.away, start: event.start }));
  const result: FinderResult = {
    intent,
    scanned: [...scannedMap.entries()].map(([sport, row]) => ({ sport, ...row })),
    oddsDetail: odds.events.length
      ? odds.detail
      : "No odds API key is required. Public scoreboard prices are labeled with the book that sent them. Exact 1xBet prices were not retrieved.",
    errors,
    candidates: shown,
    issued: slipRows,
    combined: slip.combined,
    slipNote: slip.note + screenNote,
    modelNotes,
    calibration: calibration(),
    receivedAt,
    researchStop,
    injuryDetail: injuries.detail,
    outsideWindow: [...outside.entries()].map(([sport, count]) => ({ sport, events: count })),
    blocker,
    aiCalled,
    nearby,
    coverage: {
      leaguesKnown: universeDiag?.leaguesKnown ?? 0,
      scoreboardsRead: universeDiag?.scoreboardsRead ?? 0,
      eventsDiscovered: universeDiag?.eventsDiscovered ?? merged.length,
      insideDay: events.length,
      outsideDay: [...outside.values()].reduce((sum, n) => sum + n, 0),
      footballInside: events.filter((event) => event.sport === "football").length,
      footballPre,
      basketballInside: events.filter((event) => event.sport === "basketball").length,
      summariesRead: profilePack.read,
      screened: goalCandidates.length,
      survivors: survivors.length,
      deepResearched: packetRows.length,
      note: [universeDiag?.note ?? "", profilePack.capped ? "Recent-score reads were capped so the request could finish." : ""]
        .filter(Boolean)
        .join(" "),
      day: universeDiag?.datesQueried.join(",") ?? intent.window,
    },
  };
  const runId = `run_${crypto.randomUUID()}`;
  const predictions: StoredPrediction[] = slipRows.map((row) => ({
    id: `pred_${crypto.randomUUID()}`,
    runId,
    createdAt: receivedAt,
    sport: row.sport,
    competition: row.competition,
    eventKey: eventKey(row),
    home: row.home,
    away: row.away,
    start: row.start,
    market: row.market,
    selection: row.selection,
    line: row.line,
    bookmaker: row.bookmaker,
    is1xBet: row.is1xBet,
    odds: row.decimal > 1 ? row.decimal : null,
    oddsReceivedAt: row.decimal > 1 ? receivedAt : null,
    probability: row.modelProbability,
    probabilityLabel: row.modelLabel,
    confidence: row.confirm === "model" ? "model" : "screen",
    evidence: JSON.stringify({ checks: row.checks, gaps: row.gaps, reasons: row.reasons }),
    decision: "issued",
    outcome: "pending",
    outcomeDetail: null,
  }));
  await saveRun(
    { id: runId, createdAt: receivedAt, mode: "finder", request: text, summary: JSON.stringify({ intent, slipNote: slip.note, issued: slipRows.length, scanned: result.scanned }) },
    predictions,
  );
  return result;
}

const summaryCache = new Map<string, { at: number; fact: string | null }>();

async function loadScoringNotes(events: ParsedEvent[]): Promise<Map<string, string>> {
  const targets = events
    .filter((event) => event.sport === "football" && event.source.startsWith("espn") && event.quotes.length > 0)
    .slice(0, 6);
  const notes = new Map<string, string>();
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const event = targets[cursor];
      cursor += 1;
      if (!event) continue;
      const hit = summaryCache.get(event.providerEventId);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
        if (hit.fact) notes.set(event.providerEventId, hit.fact);
        continue;
      }
      try {
        const res = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event=${encodeURIComponent(event.providerEventId)}`,
          { headers: { accept: "application/json", "user-agent": "Pitchwire/1.0" }, signal: AbortSignal.timeout(8000) },
        );
        if (!res.ok) {
          summaryCache.set(event.providerEventId, { at: Date.now(), fact: null });
          continue;
        }
        const body = (await res.json()) as { lastFiveGames?: unknown };
        const fact = scoringFact(scoringFromLastFive(body.lastFiveGames));
        summaryCache.set(event.providerEventId, { at: Date.now(), fact });
        if (fact) notes.set(event.providerEventId, fact);
      } catch {
        summaryCache.set(event.providerEventId, { at: Date.now(), fact: null });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
  return notes;
}

function hintAllows(hint: string | null, market: Quote["market"]): boolean {
  if (!hint || hint === "btts" || hint === "corners" || hint === "player") return false;
  if (hint === "total") return market === "total";
  if (hint === "spread") return market === "spread";
  if (hint === "h2h") return market === "h2h";
  return true;
}

function emptyHint(hint: string): PublicCandidate {
  return {
    id: `missing-${hint}`,
    sport: "none",
    competition: null,
    home: "No event",
    away: "No event",
    start: null,
    state: "other",
    clock: null,
    scoreHome: null,
    scoreAway: null,
    market: hint,
    selection: "unavailable",
    line: null,
    bookmaker: "none",
    is1xBet: false,
    decimal: 0,
    providerTimestamp: null,
    decision: "withheld",
    eligible: false,
    reasons: ["Withheld."],
    gaps: [`No ${hint} market was present on the connected feeds. A price was not invented.`],
    checks: [],
    modelProbability: null,
    modelLabel: null,
    noVig: null,
    eventId: "none",
    strength: null,
    overRate: null,
    confirm: "none",
  };
}

export async function runVerify(text: string): Promise<{
  picks: Array<ParsedPick & { status: string; detail: string; observed: PublicCandidate | null }>;
  receivedAt: string;
}> {
  const picks = parsePicks(text);
  const boards = await loadBoards();
  const odds = await loadOneXBetEvents(["Soccer", "Basketball", "Baseball", "Ice Hockey"]);
  const events = mergeEvents(boards.events, odds.events);
  const injuries = await loadInjuryContext(events.map((event) => event.sport));
  const receivedAt = new Date().toISOString();
  const rows = picks.map((pick) => {
    const event = events.find(
      (row) =>
        !!pick.home &&
        !!pick.away &&
        ((namesMatch(row.home, pick.home) && namesMatch(row.away, pick.away)) ||
          (namesMatch(row.home, pick.away) && namesMatch(row.away, pick.home))),
    );
    if (!event) {
      return { ...pick, status: verificationStatus({ eventFound: false, sameSide: false, lineMatched: false, issued: false, oppositeIssued: false }), detail: "No connected feed currently has this event. It was not invented.", observed: null };
    }
    const injury = injuries.forEvent(event.sport, event.home, event.away);
    const sameSide = event.quotes.filter((row) => marketSide(pick, row, event));
    const quote = sameSide.find((row) => pick.line == null || row.line == null || row.line === pick.line) ?? null;
    if (!quote && sameSide[0]) {
      const other = sameSide[0];
      return {
        ...pick,
        status: verificationStatus({ eventFound: true, sameSide: true, lineMatched: false, issued: false, oppositeIssued: false }),
        detail: `The market is on the feed, but not at this line. Observed ${other.bookmaker} ${other.selection} ${other.line} at ${other.decimal.toFixed(2)}. That price is not the pasted bet, and it is not 1xBet unless the book name is 1xBet.`,
        observed: toCandidate(event, other, 0, pick.market, injury, null),
      };
    }
    if (!quote) {
      return {
        ...pick,
        status: verificationStatus({ eventFound: true, sameSide: false, lineMatched: false, issued: false, oppositeIssued: false }),
        detail: `${event.home} vs ${event.away} is on the feed. The requested market is not in the current prices, so it is neither confirmed nor rejected.`,
        observed: null,
      };
    }
    const candidate = toCandidate(event, quote, 0, pick.market, injury, null);
    const oppositeIssued = event.quotes.some((row) => {
      if (row.market !== quote.market || row.bookmaker !== quote.bookmaker || row.line !== quote.line) return false;
      if (row.selection === quote.selection) return false;
      return toCandidate(event, row, 0, pick.market, injury, null).decision === "issued";
    });
    const status = verificationStatus({
      eventFound: true,
      sameSide: true,
      lineMatched: true,
      issued: candidate.decision === "issued",
      oppositeIssued,
    });
    return {
      ...pick,
      status,
      detail:
        status === "ALIGNED"
          ? "The same selection cleared the evidence gate."
          : status === "DISAGREEMENT"
            ? `The other side of this market cleared the gate. This side did not. Observed ${quote.bookmaker} ${quote.decimal.toFixed(2)}.`
            : `Observed ${quote.bookmaker} ${quote.decimal.toFixed(2)}. Not treated as agreement. ${candidate.gaps[0] ?? "Evidence is incomplete."}`,
      observed: candidate,
    };
  });
  if (anyModelConfigured()) {
    const review = rows.filter((row) => row.observed && row.status !== "NOT IN FEED" && row.status !== "LINE DIFFERENT");
    if (review.length > 0) {
      const reasoned = await reasonOnPacket({
        task: "Verification. The pasted pick is not truth. Include an id in issued only if the packet itself supports that exact selection.",
        count: review.length,
        candidates: review.map((row) => ({
          id: row.observed!.id,
          event: `${row.observed!.home} vs ${row.observed!.away}`,
          market: row.observed!.market,
          selection: row.observed!.selection,
          line: row.observed!.line,
          book: row.observed!.bookmaker,
          decimal: row.observed!.decimal,
          uncertainties: row.observed!.gaps.slice(0, 3),
        })),
      });
      const accepted = acceptModelPicks(
        reasoned.texts,
        new Set(review.map((row) => row.observed!.id)),
      );
      for (const row of rows) {
        if (!row.observed || row.status === "LINE DIFFERENT" || row.status === "NOT IN FEED") continue;
        if (!reasoned.texts.length) {
          row.detail += " A model was configured but returned no text. No verdict was invented.";
        } else if (accepted.ids.includes(row.observed.id)) {
          row.status = "ALIGNED";
          row.detail = accepted.reasons[row.observed.id] || "The model supported this id from the public packet.";
        } else if (accepted.parsed) {
          row.status = "DISAGREEMENT";
          row.detail = "The model did not support this pasted pick. It was not treated as true.";
        } else {
          row.detail += " The model reply was not usable JSON, so no verdict was invented.";
        }
      }
    }
  } else {
    for (const row of rows) {
      if (row.status !== "NOT IN FEED") {
        row.detail += " AI reasoning unavailable \u2014 configure an active reasoning provider. This is a feed check, not a verdict.";
      }
    }
  }
  await saveRun(
    {
      id: `run_${crypto.randomUUID()}`,
      createdAt: receivedAt,
      mode: "verify",
      request: text,
      summary: JSON.stringify({ picks: rows.length, insufficient: rows.filter((row) => row.status !== "ALIGNED").length }),
    },
    [],
  );
  return { picks: rows, receivedAt };
}

function marketSide(pick: ParsedPick, quote: Quote, event: ParsedEvent): boolean {
  if (pick.market === "unknown" || pick.market === "btts" || pick.market === "corners") return false;
  if (pick.market !== quote.market) return false;
  if (pick.market === "total") return quote.selection.toLowerCase() === pick.selection.toLowerCase();
  if (pick.selection === "Home") return namesMatch(quote.selection, event.home);
  if (pick.selection === "Away") return namesMatch(quote.selection, event.away);
  if (pick.selection === "Draw") return quote.selection === "Draw";
  return namesMatch(quote.selection, pick.selection);
}

export async function refreshSettlements(): Promise<{ settled: number }> {
  const boards = await loadBoards();
  const finals = boards.events
    .filter((event) => event.state === "post" && event.scoreHome != null && event.scoreAway != null)
    .map((event) => ({ eventKey: eventKey(event), scoreHome: event.scoreHome as number, scoreAway: event.scoreAway as number }));
  return { settled: await settlePending(finals) };
}
