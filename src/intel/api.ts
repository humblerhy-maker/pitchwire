import { createServerFn } from "@tanstack/react-start";

export const findSelections = createServerFn({ method: "POST" })
  .validator((input: { text: string }) => {
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!text) throw new Error("A request is required.");
    return { text: text.slice(0, 4000) };
  })
  .handler(async ({ data }) => {
    const { runFinder } = await import("./finder.server.ts");
    return runFinder(data.text);
  });

export const verifyPicks = createServerFn({ method: "POST" })
  .validator((input: { text: string }) => {
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!text) throw new Error("Paste at least one prediction.");
    return { text: text.slice(0, 8000) };
  })
  .handler(async ({ data }) => {
    const { runVerify } = await import("./finder.server.ts");
    return runVerify(data.text);
  });

export const providerHealth = createServerFn({ method: "GET" }).handler(async () => {
  const { keyHealth } = await import("./keys.server.ts");
  const { aiStatus } = await import("./llm.server.ts");
  return { keys: keyHealth(), providers: aiStatus() };
});

export const predictionHistory = createServerFn({ method: "GET" }).handler(async () => {
  const { listHistory, calibration } = await import("./ledger.server.ts");
  const { keyHealth } = await import("./keys.server.ts");
  const history = await listHistory();
  return { ...history, calibration: calibration(), keys: keyHealth() };
});

export const settleNow = createServerFn({ method: "POST" })
  .validator(() => ({}))
  .handler(async () => {
    const { refreshSettlements } = await import("./finder.server.ts");
    return refreshSettlements();
  });

export const saveKeys = createServerFn({ method: "POST" })
  .validator((input: { provider: "gemini" | "groq" | "cohere" | "odds-api"; keys: string }) => {
    if (input?.provider !== "gemini" && input?.provider !== "groq" && input?.provider !== "cohere" && input?.provider !== "odds-api") {
      throw new Error("Unknown provider.");
    }
    return { provider: input.provider, keys: typeof input.keys === "string" ? input.keys : "" };
  })
  .handler(async ({ data }) => {
    const { setKeys } = await import("./keys.server.ts");
    const { validateProvider } = await import("./llm.server.ts");
    const stored = setKeys(
      data.provider,
      data.keys.split(/\n+/),
    );
    const validation = stored.stored ? await validateProvider(data.provider) : "Cleared.";
    const { keyHealth } = await import("./keys.server.ts");
    return { stored: stored.stored, validation, keys: keyHealth() };
  });

export const saveBookmark = createServerFn({ method: "POST" })
  .validator((input: { payload: unknown; predictionId?: string | null }) => input)
  .handler(async ({ data }) => {
    const { addBookmark } = await import("./ledger.server.ts");
    return addBookmark(data.payload, data.predictionId ?? null);
  });
