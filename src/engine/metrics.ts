import type { Quantiles } from "./model.ts";

const MAX_SAMPLES = 4096;

export class SampleWindow {
  private values: number[] = [];

  add(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.values.push(ms);
    if (this.values.length > MAX_SAMPLES) {
      this.values.splice(0, this.values.length - MAX_SAMPLES);
    }
  }

  quantiles(): Quantiles {
    const n = this.values.length;
    if (n === 0) {
      return { n: 0, p50: null, p75: null, p90: null, p95: null, p99: null, max: null };
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    return {
      n,
      p50: nearestRank(sorted, 50),
      p75: nearestRank(sorted, 75),
      p90: nearestRank(sorted, 90),
      p95: nearestRank(sorted, 95),
      p99: nearestRank(sorted, 99),
      max: sorted[sorted.length - 1] ?? null,
    };
  }
}

/** Nearest-rank percentile. No interpolation. */
export function nearestRank(sortedAsc: number[], percentile: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? null;
}

export class Counters {
  received = 0;
  processed = 0;
  published = 0;
  duplicates = 0;
  conflicts = 0;
  failed = 0;
  malformed = 0;
  dropped = 0;
  outOfOrder = 0;
  readonly processing = new SampleWindow();
  readonly detectionUpperBound = new SampleWindow();
  readonly providerStampToReceive = new SampleWindow();
  readonly byProviderReceived = new Map<string, number>();

  bumpProvider(provider: string, n = 1): void {
    this.byProviderReceived.set(provider, (this.byProviderReceived.get(provider) ?? 0) + n);
  }

  prometheus(): string {
    const lines: string[] = [];
    const counter = (name: string, help: string, value: number, labels = "") => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${value}`);
    };
    counter("pitchwire_events_received_total", "Provider snapshots and events accepted into the engine.", this.received);
    counter("pitchwire_events_processed_total", "Events that passed validation.", this.processed);
    counter("pitchwire_events_published_total", "Events published to clients.", this.published);
    counter("pitchwire_events_duplicate_total", "Duplicate observations suppressed.", this.duplicates);
    counter("pitchwire_events_conflict_total", "Recorded provider disagreements.", this.conflicts);
    counter("pitchwire_events_failed_total", "Poll or parse failures.", this.failed);
    counter("pitchwire_events_malformed_total", "Payloads or records that could not be parsed.", this.malformed);
    counter("pitchwire_events_dropped_total", "Stale or rejected records.", this.dropped);
    for (const [provider, n] of this.byProviderReceived) {
      lines.push(`pitchwire_provider_events_received_total{provider="${provider}"} ${n}`);
    }
    const q = (metric: string, help: string, window: SampleWindow) => {
      const s = window.quantiles();
      lines.push(`# HELP ${metric} ${help}`);
      lines.push(`# TYPE ${metric} gauge`);
      lines.push(`${metric}_samples ${s.n}`);
      if (s.n === 0) return;
      for (const [label, value] of [
        ["0.5", s.p50],
        ["0.75", s.p75],
        ["0.9", s.p90],
        ["0.95", s.p95],
        ["0.99", s.p99],
        ["1", s.max],
      ] as const) {
        if (value !== null) lines.push(`${metric}{quantile="${label}"} ${value}`);
      }
    };
    q(
      "pitchwire_event_processing_ms",
      "Monotonic milliseconds from body receipt to publish. Measured, not estimated.",
      this.processing,
    );
    q(
      "pitchwire_detection_upper_bound_ms",
      "Milliseconds since the previous poll when a change was observed. Upper bound only.",
      this.detectionUpperBound,
    );
    q(
      "pitchwire_provider_stamp_to_receive_ms",
      "Milliseconds from a provider-supplied timestamp to our receipt. Absent when the provider sent none.",
      this.providerStampToReceive,
    );
    return `${lines.join("\n")}\n`;
  }
}
