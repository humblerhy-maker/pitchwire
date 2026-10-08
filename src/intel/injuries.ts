import { canonicalName } from "../engine/ids.ts";

export interface InjuryRow {
  team: string;
  athlete: string;
  status: string;
  detail: string;
}

export interface InjuryTeam {
  team: string;
  rows: InjuryRow[];
}

/** ESPN site injury board: `{ injuries: [{ displayName, injuries: [...] }] }`. An empty team list is not "no injuries". */
export function parseEspnInjuryBoard(raw: unknown): InjuryTeam[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { injuries?: unknown }).injuries)) return null;
  const teams: InjuryTeam[] = [];
  for (const row of (raw as { injuries: unknown[] }).injuries) {
    if (!row || typeof row !== "object") continue;
    const team = (row as { displayName?: unknown }).displayName;
    if (typeof team !== "string" || !team.trim()) continue;
    const items = (row as { injuries?: unknown }).injuries;
    const parsed: InjuryRow[] = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const athlete = (item as { athlete?: { displayName?: unknown } }).athlete?.displayName;
        const status = (item as { status?: unknown }).status;
        if (typeof athlete !== "string" || typeof status !== "string") continue;
        const details = (item as { details?: { detail?: unknown } }).details?.detail;
        parsed.push({
          team,
          athlete,
          status,
          detail: typeof details === "string" ? details : "",
        });
      }
    }
    teams.push({ team, rows: parsed });
  }
  return teams;
}

export function lookupTeam(teams: InjuryTeam[], name: string): { found: boolean; rows: InjuryRow[] } {
  const key = canonicalName(name);
  if (!key) return { found: false, rows: [] };
  const team = teams.find((row) => {
    const other = canonicalName(row.team);
    return other === key || other.includes(key) || key.includes(other);
  });
  if (!team) return { found: false, rows: [] };
  return { found: true, rows: team.rows };
}

const MATERIAL = /out|reserve|il\b|doubt|suspend|season/i;

/** Names that can change a lineup. Day-to-day is kept only when nothing stronger is listed. */
export function injuryFact(team: string, rows: InjuryRow[]): string {
  if (rows.length === 0) return `ESPN report for ${team}: no players listed.`;
  const material = rows.filter((row) => MATERIAL.test(row.status));
  const shown = (material.length > 0 ? material : rows).slice(0, 3);
  const text = shown.map((row) => `${row.athlete} (${row.status}${row.detail ? `, ${row.detail}` : ""})`).join("; ");
  const extra = rows.length > shown.length ? ` +${rows.length - shown.length} more` : "";
  return `ESPN report for ${team}: ${text}${extra}.`;
}
