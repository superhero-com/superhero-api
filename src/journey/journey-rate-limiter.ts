import { Injectable, Logger } from '@nestjs/common';
import { JOURNEY_LIMITS } from './journey.constants';

const WINDOW_MS = 60_000;

/**
 * Per-minute caps on accepted journey events, per client IP and in total: the
 * ingest is public and every accepted event becomes a row kept for months.
 */
@Injectable()
export class JourneyRateLimiter {
  private readonly logger = new Logger(JourneyRateLimiter.name);
  private windowStart = 0;
  private total = 0;
  private dropped = 0;
  private readonly perClient = new Map<string, number>();

  /** Returns how many of `count` events from `client` may be kept. */
  take(client: string, count: number, now: number = Date.now()): number {
    if (now - this.windowStart >= WINDOW_MS) {
      if (this.dropped > 0) {
        this.logger.warn(
          `Journey ingest dropped ${this.dropped} events over the per-minute caps; accepted ${this.total} of ${JOURNEY_LIMITS.MAX_EVENTS_PER_MINUTE}`,
        );
      }
      this.windowStart = now;
      this.total = 0;
      this.dropped = 0;
      this.perClient.clear();
    }
    const used = this.perClient.get(client) ?? 0;
    const allowed = Math.max(
      0,
      Math.min(
        count,
        JOURNEY_LIMITS.MAX_EVENTS_PER_CLIENT_PER_MINUTE - used,
        JOURNEY_LIMITS.MAX_EVENTS_PER_MINUTE - this.total,
      ),
    );
    this.dropped += count - allowed;
    // Refused clients get no entry, so the map stays bounded by the global cap.
    if (allowed > 0) {
      this.perClient.set(client, used + allowed);
      this.total += allowed;
    }
    return allowed;
  }
}
