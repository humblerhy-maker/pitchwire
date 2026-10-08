/** Decimal and American prices. Implied probability is 1/decimal and still includes the margin. */

export function americanToDecimal(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

export function parseAmerican(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const text = raw.trim().toUpperCase();
  if (!text || text === "OFF" || text === "EVEN") return text === "EVEN" ? 100 : null;
  const n = Number(text.replace(/^\+/, ""));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

export function impliedFromDecimal(decimal: number): number | null {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  return 1 / decimal;
}

export function overround(implied: number[]): number | null {
  if (implied.length < 2 || implied.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return implied.reduce((sum, n) => sum + n, 0) - 1;
}

/** Proportional removal of the margin. Not a true probability. */
export function noVig(implied: number[], index: number): number | null {
  const sum = implied.reduce((total, n) => total + n, 0);
  const value = implied[index];
  if (!value || sum <= 0) return null;
  return value / sum;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function product(decimals: number[]): number | null {
  if (decimals.length === 0) return null;
  const value = decimals.reduce((acc, n) => acc * n, 1);
  return Number.isFinite(value) ? round4(value) : null;
}
