import { settleSelection, type Outcome } from "./settle.ts";

export interface StoredPrediction {
  id: string;
  runId: string;
  createdAt: string;
  sport: string;
  competition: string | null;
  eventKey: string;
  home: string;
  away: string;
  start: string | null;
  market: string;
  selection: string;
  line: number | null;
  bookmaker: string | null;
  is1xBet: boolean;
  odds: number | null;
  oddsReceivedAt: string | null;
  probability: number | null;
  probabilityLabel: string | null;
  confidence: string;
  evidence: string;
  decision: string;
  outcome: Outcome;
  outcomeDetail: string | null;
}

interface RunRow {
  id: string;
  createdAt: string;
  mode: string;
  request: string;
  summary: string;
}

const memoryRuns: RunRow[] = [];
const memoryPredictions: StoredPrediction[] = [];
const memoryBookmarks: Array<{ id: string; createdAt: string; predictionId: string | null; payload: string }> = [];

export async function saveRun(run: RunRow, predictions: StoredPrediction[]): Promise<void> {
  memoryRuns.unshift(run);
  memoryPredictions.unshift(...predictions);
  if (memoryRuns.length > 100) memoryRuns.pop();
  try {
    const { getSql } = await import("../lib/db.ts");
    const sql = await getSql();
    await sql.query(
      `insert into pitch_prediction_runs (id, created_at, mode, request_text, intent, result)
       values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`,
      [run.id, run.createdAt, run.mode, run.request, run.summary, run.summary],
    );
    for (const row of predictions) {
      await sql.query(
        `insert into pitch_predictions (
          id, run_id, created_at, sport, competition, event_key, home_name, away_name, start_time,
          market, selection, line, bookmaker, is_1xbet, odds, odds_received_at, probability,
          probability_label, confidence, evidence, decision, outcome, outcome_detail
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        on conflict (id) do nothing`,
        [
          row.id, row.runId, row.createdAt, row.sport, row.competition, row.eventKey, row.home, row.away,
          row.start, row.market, row.selection, row.line, row.bookmaker, row.is1xBet, row.odds,
          row.oddsReceivedAt, row.probability, row.probabilityLabel, row.confidence, row.evidence,
          row.decision, row.outcome, row.outcomeDetail,
        ],
      );
    }
  } catch (err) {
    console.error("[pitchwire] prediction ledger", err instanceof Error ? err.message : "failed");
  }
}

let hydrateAttempted = false;

async function ensureHydrated(): Promise<void> {
  if (hydrateAttempted || memoryRuns.length > 0) return;
  hydrateAttempted = true;
  try {
    const { getSql } = await import("../lib/db.ts");
    const sql = await getSql();
    const runs = await sql.query<{ id: string; created_at: string; mode: string; request_text: string; intent: string }>(
      `select id, created_at, mode, request_text, intent from pitch_prediction_runs order by created_at desc limit 30`,
    );
    const predictions = await sql.query<{
      id: string;
      run_id: string;
      created_at: string;
      sport: string;
      competition: string | null;
      event_key: string;
      home_name: string;
      away_name: string;
      start_time: string | null;
      market: string;
      selection: string;
      line: number | null;
      bookmaker: string | null;
      is_1xbet: boolean;
      odds: number | null;
      odds_received_at: string | null;
      probability: number | null;
      probability_label: string | null;
      confidence: string;
      evidence: string;
      decision: string;
      outcome: string;
      outcome_detail: string | null;
    }>(
      `select id, run_id, created_at, sport, competition, event_key, home_name, away_name, start_time,
              market, selection, line, bookmaker, is_1xbet, odds, odds_received_at, probability,
              probability_label, confidence, evidence, decision, outcome, outcome_detail
       from pitch_predictions order by created_at desc limit 80`,
    );
    const bookmarks = await sql.query<{ id: string; created_at: string; prediction_id: string | null; payload: string }>(
      `select id, created_at, prediction_id, payload from pitch_bookmarks order by created_at desc limit 40`,
    );
    if (memoryRuns.length > 0) return;
    for (const row of runs) {
      memoryRuns.push({ id: row.id, createdAt: row.created_at, mode: row.mode, request: row.request_text, summary: row.intent });
    }
    for (const row of predictions) {
      memoryPredictions.push({
        id: row.id,
        runId: row.run_id,
        createdAt: row.created_at,
        sport: row.sport,
        competition: row.competition,
        eventKey: row.event_key,
        home: row.home_name,
        away: row.away_name,
        start: row.start_time,
        market: row.market,
        selection: row.selection,
        line: row.line,
        bookmaker: row.bookmaker,
        is1xBet: row.is_1xbet,
        odds: row.odds,
        oddsReceivedAt: row.odds_received_at,
        probability: row.probability,
        probabilityLabel: row.probability_label,
        confidence: row.confidence,
        evidence: row.evidence,
        decision: row.decision,
        outcome: row.outcome === "won" || row.outcome === "lost" || row.outcome === "push" || row.outcome === "void" ? row.outcome : "pending",
        outcomeDetail: row.outcome_detail,
      });
    }
    for (const row of bookmarks) {
      memoryBookmarks.push({ id: row.id, createdAt: row.created_at, predictionId: row.prediction_id, payload: row.payload });
    }
  } catch (err) {
    console.error("[pitchwire] ledger hydrate", err instanceof Error ? err.message : "failed");
  }
}

export async function listHistory(): Promise<{ runs: RunRow[]; predictions: StoredPrediction[]; bookmarks: typeof memoryBookmarks }> {
  await ensureHydrated();
  return {
    runs: memoryRuns.slice(0, 30),
    predictions: memoryPredictions.slice(0, 80),
    bookmarks: memoryBookmarks.slice(0, 40),
  };
}

export async function settlePending(finals: Array<{ eventKey: string; scoreHome: number; scoreAway: number }>): Promise<number> {
  const byKey = new Map(finals.map((row) => [row.eventKey, row]));
  let changed = 0;
  for (const row of memoryPredictions) {
    if (row.outcome !== "pending" || row.decision !== "issued") continue;
    const final = byKey.get(row.eventKey);
    if (!final) continue;
    const settled = settleSelection({
      market: row.market,
      selection: row.selection,
      line: row.line,
      home: row.home,
      away: row.away,
      scoreHome: final.scoreHome,
      scoreAway: final.scoreAway,
      final: true,
    });
    if (settled.outcome === "pending") continue;
    row.outcome = settled.outcome;
    row.outcomeDetail = settled.detail;
    changed += 1;
    try {
      const { getSql } = await import("../lib/db.ts");
      const sql = await getSql();
      await sql.query(
        `update pitch_predictions set outcome = $2, outcome_detail = $3, settled_at = $4 where id = $1`,
        [row.id, settled.outcome, settled.detail, new Date().toISOString()],
      );
    } catch (err) {
      console.error("[pitchwire] settle", err instanceof Error ? err.message : "failed");
    }
  }
  return changed;
}

export async function addBookmark(payload: unknown, predictionId: string | null): Promise<{ id: string }> {
  const row = {
    id: `bm_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    predictionId,
    payload: JSON.stringify(payload),
  };
  memoryBookmarks.unshift(row);
  try {
    const { getSql } = await import("../lib/db.ts");
    const sql = await getSql();
    await sql.query(
      `insert into pitch_bookmarks (id, created_at, prediction_id, payload) values ($1,$2,$3,$4)`,
      [row.id, row.createdAt, row.predictionId, row.payload],
    );
  } catch (err) {
    console.error("[pitchwire] bookmark", err instanceof Error ? err.message : "failed");
  }
  return { id: row.id };
}

export function calibration(predictions = memoryPredictions): {
  issued: number;
  settled: number;
  won: number;
  lost: number;
  note: string;
} {
  const issued = predictions.filter((row) => row.decision === "issued");
  const settled = issued.filter((row) => row.outcome === "won" || row.outcome === "lost");
  const won = settled.filter((row) => row.outcome === "won").length;
  return {
    issued: issued.length,
    settled: settled.length,
    won,
    lost: settled.length - won,
    note:
      settled.length === 0
        ? "No settled issued predictions yet. Win rate is not estimated from an empty set."
        : "Win rate uses issued predictions only, after a final score was observed. Past rows are not rewritten.",
  };
}
