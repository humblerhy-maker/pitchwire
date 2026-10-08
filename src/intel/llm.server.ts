import { markKey, nextKey } from "./keys.server.ts";

export interface ModelNote {
  provider: "gemini" | "groq" | "cohere" | "grok";
  model: string;
  ok: boolean;
  text: string;
  cached: boolean;
}

const GEMINI_MODEL = "gemini-3.8-flash";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const COHERE_MODEL = "command-a-03-2025";
const GROK_MODEL = "grok-4.5";

export interface ProviderState {
  provider: string;
  model: string;
  state: "healthy" | "configured" | "degraded" | "disconnected";
  detail: string;
}

const lastCall: Record<string, "ok" | "err" | "none"> = { gemini: "none", groq: "none", cohere: "none", grok: "none" };

export function aiStatus(): ProviderState[] {
  const grokKey = Boolean(process.env.XAI_API_KEY);
  return [
    row("grok", GROK_MODEL, grokKey, "App reasoning key. It is not shown and not stored in the database."),
    row("gemini", GEMINI_MODEL, has("gemini"), "Paste a key in Settings. Nothing is called until you run Finder or Verify."),
    row("groq", GROQ_MODEL, has("groq"), "Paste a key in Settings."),
    row("cohere", COHERE_MODEL, has("cohere"), "Paste a key in Settings. Chat model command-a-03-2025."),
  ];
}

function has(provider: "gemini" | "groq" | "cohere"): boolean {
  return nextKey(provider) != null;
}

function row(provider: string, model: string, present: boolean, detail: string): ProviderState {
  if (!present) return { provider, model, state: "disconnected", detail };
  const last = lastCall[provider] ?? "none";
  if (last === "ok") return { provider, model, state: "healthy", detail: "Last call returned text." };
  if (last === "err") return { provider, model, state: "degraded", detail: "Last call failed. No substitute text was invented." };
  return { provider, model, state: "configured", detail };
}

const reasonCache = new Map<string, { at: number; notes: ModelNote[] }>();

export async function reasonOnPacket(packet: unknown): Promise<{ notes: ModelNote[]; texts: string[]; cached: boolean }> {
  const body = JSON.stringify(packet).slice(0, 14000);
  const cacheKey = body;
  const hit = reasonCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
    return { notes: hit.notes.map((note) => ({ ...note, cached: true })), texts: hit.notes.filter((note) => note.ok).map((note) => note.text), cached: true };
  }
  const prompt =
    "You are the reasoning layer for a sports finder. Use ONLY the JSON packet. " +
    "Do not invent fixtures, prices, injuries, lineups, or statistics. " +
    "A short price is not a reason to select. Do not add a weak leg to reach a combined-odds target. " +
    "overRate is a 0 to 1 recent frequency, not a certainty. strength is a screen score, not a probability. " +
    "Rank ids with overRate at least 0.6 and at least 4 games, up to the requested count. " +
    "If the two clubs disagree sharply, omit that id and say so only by omitting it. " +
    "A missing injury report is a risk to mention in the reason, not a reason to return an empty list when other ids clear that bar. " +
    "If no id has a usable overRate, rank priced markets only when the packet has no overRate field, and still do not treat a short price as safety. " +
    "Return JSON only, no markdown: {\"issued\":[{\"id\":\"copy an id from the packet\",\"reason\":\"one sentence citing only packet fields, including the main risk\"}]}. " +
    packetInstruction(packet) +
    "\n" +
    body;
  const notes = (
    await Promise.all([callGemini(prompt), callGroq(prompt), callCohere(prompt), callGrok(prompt)])
  ).filter((note): note is ModelNote => note !== null);
  if (notes.some((note) => note.ok)) reasonCache.set(cacheKey, { at: Date.now(), notes });
  return { notes, texts: notes.filter((note) => note.ok).map((note) => note.text), cached: false };
}

function packetInstruction(packet: unknown): string {
  const count = packet && typeof packet === "object" && typeof (packet as { count?: unknown }).count === "number" ? (packet as { count: number }).count : null;
  return count ? `Return at most ${count} ids.` : "Return at most 3 ids.";
}

export function anyModelConfigured(): boolean {
  return Boolean(process.env.XAI_API_KEY) || has("gemini") || has("groq") || has("cohere");
}

async function callGemini(prompt: string): Promise<ModelNote | null> {
  const key = nextKey("gemini");
  if (!key) return null;
  return callJson("gemini", GEMINI_MODEL, async () => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key.secret },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 400, temperature: 0 } }),
      signal: AbortSignal.timeout(28000),
    });
    const text = res.ok
      ? ((await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join(" ") ?? ""
      : "";
    return { res, text };
  }, key.index);
}

async function callGroq(prompt: string): Promise<ModelNote | null> {
  const key = nextKey("groq");
  if (!key) return null;
  return callOpenAI("groq", GROQ_MODEL, "https://api.groq.com/openai/v1/chat/completions", key.secret, key.index, prompt);
}

async function callCohere(prompt: string): Promise<ModelNote | null> {
  const key = nextKey("cohere");
  if (!key) return null;
  return callJson("cohere", COHERE_MODEL, async () => {
    const res = await fetch("https://api.cohere.com/v2/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({
        model: COHERE_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(28000),
    });
    const json = res.ok ? ((await res.json()) as { message?: { content?: Array<{ text?: string }> } }) : null;
    const text = json?.message?.content?.map((part) => part.text ?? "").join(" ") ?? "";
    return { res, text };
  }, key.index);
}

async function callGrok(prompt: string): Promise<ModelNote | null> {
  const secret = process.env.XAI_API_KEY;
  if (!secret) return null;
  return callOpenAI("grok", GROK_MODEL, "https://api.x.ai/v1/chat/completions", secret, -1, prompt);
}

async function callOpenAI(
  provider: ModelNote["provider"],
  model: string,
  url: string,
  secret: string,
  index: number,
  prompt: string,
): Promise<ModelNote> {
  return callJson(provider, model, async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(28000),
    });
    const json = res.ok ? ((await res.json()) as { choices?: Array<{ message?: { content?: string } }> }) : null;
    return { res, text: json?.choices?.[0]?.message?.content ?? "" };
  }, index);
}

async function callJson(
  provider: ModelNote["provider"],
  model: string,
  run: () => Promise<{ res: Response; text: string }>,
  index: number,
): Promise<ModelNote> {
  try {
    const { res, text } = await run();
    if (res.status === 429) {
      if (index >= 0) markKey(provider === "grok" ? "groq" : provider, index, "cooling", "429", 60_000);
      lastCall[provider] = "err";
      return { provider, model, ok: false, text: `${provider} rate limited. Not retried.`, cached: false };
    }
    if (!res.ok) {
      if (index >= 0 && provider !== "grok") {
        markKey(provider, index, res.status === 401 || res.status === 403 ? "rejected" : "cooling", `HTTP ${res.status}`, 30_000);
      }
      lastCall[provider] = "err";
      return { provider, model, ok: false, text: `${provider} HTTP ${res.status}. No text was treated as evidence.`, cached: false };
    }
    if (index >= 0 && provider !== "grok") markKey(provider, index, "ok");
    lastCall[provider] = text.trim() ? "ok" : "err";
    return { provider, model, ok: Boolean(text.trim()), text: text.slice(0, 4000) || "Empty model response. Ignored.", cached: false };
  } catch (err) {
    lastCall[provider] = "err";
    if (index >= 0 && provider !== "grok") {
      markKey(provider, index, "cooling", err instanceof Error ? err.message : "request failed", 30_000);
    }
    return { provider, model, ok: false, text: `${provider} request failed. No substitute text was invented.`, cached: false };
  }
}

export async function validateProvider(provider: "gemini" | "groq" | "cohere" | "odds-api"): Promise<string> {
  const key = nextKey(provider);
  if (!key) return "No key stored.";
  if (provider === "odds-api") {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${encodeURIComponent(key.secret)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      markKey(provider, key.index, res.status === 401 ? "rejected" : "cooling", `HTTP ${res.status}`, 30_000);
      return `Odds API HTTP ${res.status}.`;
    }
    markKey(provider, key.index, "ok");
    return "Odds API accepted the key. It is optional. Finder does not require it.";
  }
  const ping = "Reply with JSON only: {\"issued\":[]}";
  const note =
    provider === "gemini" ? await callGemini(ping) : provider === "groq" ? await callGroq(ping) : await callCohere(ping);
  return note?.ok ? `${provider} responded.` : note?.text || "No response.";
}
