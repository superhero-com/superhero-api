import { Injectable, Logger } from '@nestjs/common';
import { JOURNEY_LIMITS } from './journey.constants';

const WINDOW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Caps on accepted journey events: per client IP and in total per minute, and
 * in total per UTC day. The ingest is public and every accepted event becomes
 * a row kept for months, so the daily cap is what bounds the table's growth.
 * Several clients flooding together can still use up the day and drop
 * everyone's events until UTC midnight; analytics are best-effort and the
 * disk is shared. The counts live in this process's memory: a restart starts
 * a fresh day, and each extra instance accepts its own share on top.
 */
@Injectable()
export class JourneyRateLimiter {
  private readonly logger = new Logger(JourneyRateLimiter.name);
  private windowStart = 0;
  private total = 0;
  private dropped = 0;
  private day = -1;
  private dayTotal = 0;
  private readonly perClient = new Map<string, number>();

  /** Returns how many of `count` events from `client` may be kept. */
  take(client: string, count: number, now: number = Date.now()): number {
    if (now - this.windowStart >= WINDOW_MS) {
      if (this.dropped > 0) {
        // `error`: production keeps only error-level logs.
        this.logger.error(
          `Journey ingest dropped ${this.dropped} events over the caps; accepted ${this.total} of ${JOURNEY_LIMITS.MAX_EVENTS_PER_MINUTE} in the minute, ${this.dayTotal} of ${JOURNEY_LIMITS.MAX_EVENTS_PER_DAY} in the UTC day`,
        );
      }
      this.windowStart = now;
      this.total = 0;
      this.dropped = 0;
      this.perClient.clear();
    }
    const day = Math.floor(now / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.dayTotal = 0;
    }
    const used = this.perClient.get(client) ?? 0;
    const allowed = Math.max(
      0,
      Math.min(
        count,
        JOURNEY_LIMITS.MAX_EVENTS_PER_CLIENT_PER_MINUTE - used,
        JOURNEY_LIMITS.MAX_EVENTS_PER_MINUTE - this.total,
        JOURNEY_LIMITS.MAX_EVENTS_PER_DAY - this.dayTotal,
      ),
    );
    this.dropped += count - allowed;
    // Refused clients get no entry, so the map stays bounded by the global cap.
    if (allowed > 0) {
      this.perClient.set(client, used + allowed);
      this.total += allowed;
      this.dayTotal += allowed;
    }
    return allowed;
  }
}
