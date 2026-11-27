import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const MEASUREMENT_OUTCOMES = [
  'accepted_update',
  'ignored_below_threshold',
  'rejected_duplicate_or_forgotten',
  'invalid_request',
  'invalid_evidence',
  'content_unavailable',
  'service_unavailable',
  'server_error',
  'rate_limited',
] as const;
export type MeasurementOutcome = (typeof MEASUREMENT_OUTCOMES)[number];
type Counters = Record<MeasurementOutcome, number>;
const bucketMs = 300000;
const buckets = 12;
const empty = (): Counters =>
  Object.fromEntries(MEASUREMENT_OUTCOMES.map((key) => [key, 0])) as Counters;
const failures: Partial<Record<number, MeasurementOutcome>> = {
  400: 'invalid_request',
  401: 'invalid_evidence',
  404: 'content_unavailable',
  429: 'rate_limited',
  503: 'service_unavailable',
};

// Process-local operational counters only: no request identifiers, payloads,
// per-client keys, IO or background timers. Scrape each replica independently.
@Injectable()
export class ShortsMeasurementMonitorService {
  private readonly instance = randomUUID();
  private readonly startedAt = Date.now();
  private readonly started = performance.now();
  private readonly cumulative = empty();
  private readonly ring = Array.from({ length: buckets }, () => ({
    index: -1,
    counts: empty(),
  }));
  private saturated = false;

  private elapsed() {
    return Math.max(0, Math.floor(performance.now() - this.started));
  }

  record(outcome: MeasurementOutcome) {
    // Keep the runtime boundary fixed even if called from untyped code.
    if (!MEASUREMENT_OUTCOMES.includes(outcome)) return;
    const index = Math.floor(this.elapsed() / bucketMs);
    const slot = this.ring[index % buckets];
    if (slot.index !== index) {
      slot.index = index;
      slot.counts = empty();
    }
    for (const counters of [this.cumulative, slot.counts]) {
      if (counters[outcome] < Number.MAX_SAFE_INTEGER) counters[outcome] += 1;
      else this.saturated = true;
    }
  }

  failure(status: number) {
    this.record(failures[status] ?? 'server_error');
  }

  snapshot() {
    const elapsed = this.elapsed();
    const index = Math.floor(elapsed / bucketMs);
    return {
      version: 1,
      scope: 'process' as const,
      instance: this.instance,
      startedAt: this.startedAt,
      observedAt: this.startedAt + elapsed,
      uptimeMs: elapsed,
      bucketMs,
      windowMs: bucketMs * buckets,
      saturated: this.saturated,
      cumulative: { ...this.cumulative },
      recent: this.ring
        .filter((slot) => slot.index >= 0 && slot.index > index - buckets)
        .sort((a, b) => a.index - b.index)
        .map((slot) => ({
          from: this.startedAt + slot.index * bucketMs,
          until:
            this.startedAt + Math.min((slot.index + 1) * bucketMs, elapsed),
          partial: slot.index === index,
          counts: { ...slot.counts },
        })),
    };
  }
}
