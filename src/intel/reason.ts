/** Ranking and model-output checks. No network. A short price is a penalty, never a bonus. */

export function evidenceScore(input: {
  decimal: number;
  marketMatches: boolean;
  injuryKnown: boolean;
  sampleGames: number;
  live: boolean;
}): number {
  let score = 0;
  if (input.marketMatches) score += 4;
  if (input.injuryKnown) score += 3;
  if (input.sampleGames >= 5) score += 3;
  else if (input.sampleGames >= 3) score += 1;
  if (input.live) score += 1;
  if (input.decimal > 1 && input.decimal < 1.4) score -= 5;
  return score;
}

export interface IssuedRow {
  id: string;
  reason: string;
}

export function extractIssued(text: string): IssuedRow[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const json = JSON.parse(text.slice(start, end + 1)) as { issued?: unknown };
    if (!Array.isArray(json.issued)) return null;
    const rows: IssuedRow[] = [];
    for (const row of json.issued) {
      if (!row || typeof row !== "object") continue;
      const id = (row as { id?: unknown }).id;
      const reason = (row as { reason?: unknown }).reason;
      if (typeof id !== "string" || !id.trim()) continue;
      rows.push({ id: id.trim(), reason: typeof reason === "string" ? reason.slice(0, 280) : "" });
    }
    return rows;
  } catch {
    return null;
  }
}

/** Keeps only ids that were in the packet. Drops invented ids. If two models disagree, the id is not issued. */
export function acceptModelPicks(texts: string[], allowed: Set<string>): {
  ids: string[];
  reasons: Record<string, string>;
  invented: string[];
  disagreement: string[];
  parsed: boolean;
} {
  const votes: Array<Set<string>> = [];
  const reasons: Record<string, string> = {};
  const invented: string[] = [];
  let parsed = false;
  for (const text of texts) {
    const rows = extractIssued(text);
    if (!rows) continue;
    parsed = true;
    const ok = new Set<string>();
    for (const row of rows) {
      if (!allowed.has(row.id)) {
        invented.push(row.id);
        continue;
      }
      ok.add(row.id);
      if (row.reason) reasons[row.id] = row.reason;
    }
    votes.push(ok);
  }
  if (votes.length === 0) return { ids: [], reasons, invented, disagreement: [], parsed };
  let ids = [...votes[0]!];
  const disagreement: string[] = [];
  if (votes.length > 1) {
    ids = ids.filter((id) => votes.every((vote) => vote.has(id)));
    const union = new Set(votes.flatMap((vote) => [...vote]));
    for (const id of union) if (!ids.includes(id)) disagreement.push(id);
  }
  return { ids, reasons, invented, disagreement, parsed };
}
