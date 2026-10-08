import type { ProviderSnapshot } from "../engine/model.ts";

export interface ProviderCapabilities {
  id: string;
  label: string;
  supportsLiveMatches: boolean;
  supportsGoalEvents: boolean;
  supportsWebsocket: boolean;
  supportsSse: boolean;
  supportsPush: boolean;
  supportsTimestamps: boolean;
  transport: "poll" | "websocket" | "sse" | "stream";
  /** Null when the provider has not published an update interval. */
  documentedUpdateMs: number | null;
  pollIntervalMs: number | null;
  official: boolean;
  requiresKey: boolean;
  role: "baseline" | "reference" | "candidate" | "demo";
  freeAccess: boolean;
  trial: boolean;
  /** Provider's own words, or "UNKNOWN". Never our guess of goal delay. */
  documentedLatency: string;
  upstream: string;
  notes: string;
}

export interface NormalizeResult {
  snapshots: ProviderSnapshot[];
  malformed: number;
}

export interface ValidationReport {
  ok: boolean;
  detail: string;
  httpStatus: number | null;
}

export interface PollPayload {
  raw: unknown;
  httpStatus: number;
  receivedAtMs: number;
  receivedMono: number;
  parsedAtMs?: number;
}

/** Stamp after the bytes arrive and before JSON.parse. */
export async function readJsonBody(res: Response): Promise<{ raw: unknown; receivedAtMs: number; receivedMono: number; parsedAtMs: number }> {
  const text = await res.text();
  const receivedAtMs = Date.now();
  const receivedMono = performance.now();
  let raw: unknown = null;
  if (text) {
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      raw = null;
    }
  }
  const parsedAtMs = Date.now();
  return { raw, receivedAtMs, receivedMono, parsedAtMs };
}

export interface LiveSportsProvider {
  capabilities: ProviderCapabilities;
  configured(): boolean;
  /** Shown while the provider is intentionally not connected. */
  disconnectedDetail?: () => string;
  validate(): Promise<ValidationReport>;
  poll(fetchImpl: typeof fetch): Promise<PollPayload>;
  normalize(raw: unknown): NormalizeResult;
}

