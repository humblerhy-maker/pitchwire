export type AiProvider = "gemini" | "groq" | "cohere" | "odds-api";

export interface KeyHealth {
  provider: AiProvider;
  index: number;
  state: "unknown" | "ok" | "rejected" | "cooling";
  uses: number;
  cooldownUntil: string | null;
  lastError: string;
}

interface Slot {
  secret: string;
  state: KeyHealth["state"];
  uses: number;
  cooldownUntil: number;
  lastError: string;
}

const g = globalThis as typeof globalThis & { __pitchwireKeys?: Record<AiProvider, Slot[]> };

function store(): Record<AiProvider, Slot[]> {
  if (!g.__pitchwireKeys) {
    g.__pitchwireKeys = { gemini: [], groq: [], cohere: [], "odds-api": [] };
    seedFromEnv();
  }
  if (!g.__pitchwireKeys.cohere) g.__pitchwireKeys.cohere = [];
  return g.__pitchwireKeys;
}

function seedFromEnv(): void {
  const read = (names: string[]) =>
    names
      .flatMap((name) => (process.env[name] ?? "").split(/[\n,]/))
      .map((value) => value.trim())
      .filter(Boolean);
  const box = g.__pitchwireKeys!;
  for (const secret of read(["GEMINI_API_KEY", "GEMINI_API_KEYS"])) box.gemini.push(blank(secret));
  for (const secret of read(["GROQ_API_KEY", "GROQ_API_KEYS"])) box.groq.push(blank(secret));
  for (const secret of read(["COHERE_API_KEY", "COHERE_API_KEYS"])) box.cohere.push(blank(secret));
  for (const secret of read(["ODDS_API_KEY", "THE_ODDS_API_KEY"])) box["odds-api"].push(blank(secret));
}

function blank(secret: string): Slot {
  return { secret, state: "unknown", uses: 0, cooldownUntil: 0, lastError: "" };
}

export function keyHealth(): KeyHealth[] {
  const rows: KeyHealth[] = [];
  for (const provider of ["gemini", "groq", "cohere", "odds-api"] as const) {
    store()[provider].forEach((slot, index) => {
      rows.push({
        provider,
        index: index + 1,
        state: slot.cooldownUntil > Date.now() ? "cooling" : slot.state,
        uses: slot.uses,
        cooldownUntil: slot.cooldownUntil ? new Date(slot.cooldownUntil).toISOString() : null,
        lastError: slot.lastError,
      });
    });
  }
  return rows;
}

export function setKeys(provider: AiProvider, secrets: string[]): { stored: number } {
  const cleaned = secrets.map((value) => value.trim()).filter((value) => value.length >= 8);
  store()[provider] = cleaned.map(blank);
  return { stored: cleaned.length };
}

export function nextKey(provider: AiProvider): { index: number; secret: string } | null {
  const slots = store()[provider];
  const now = Date.now();
  const index = slots.findIndex((slot) => slot.state !== "rejected" && slot.cooldownUntil <= now);
  const slot = index >= 0 ? slots[index] : null;
  if (!slot) return null;
  return { index, secret: slot.secret };
}

export function markKey(provider: AiProvider, index: number, result: "ok" | "rejected" | "cooling", error = "", cooldownMs = 0): void {
  const slot = store()[provider][index];
  if (!slot) return;
  slot.uses += 1;
  slot.state = result === "cooling" ? "cooling" : result;
  slot.lastError = error.slice(0, 240);
  if (result === "cooling") slot.cooldownUntil = Date.now() + cooldownMs;
  if (result === "ok") slot.cooldownUntil = 0;
}
