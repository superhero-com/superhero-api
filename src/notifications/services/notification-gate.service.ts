import { Injectable, Logger } from '@nestjs/common';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationRedisService } from './notification-redis.service';

export interface RateLimit {
  cap: number;
  windowSec: number;
}

/**
 * Per-recipient gate for event-driven notifications that are cheap to trigger
 * (comments, mentions, tips). Each event is a distinct txHash, so the
 * per-(tx, recipient) dedup never coalesces a storm aimed at one account.
 */
@Injectable()
export class NotificationGateService {
  private readonly logger = new Logger(NotificationGateService.name);

  constructor(
    private readonly preferences: NotificationPreferencesService,
    private readonly redis: NotificationRedisService,
  ) {}

  /**
   * Opt-out before the cap, so an opted-out recipient never spends budget and
   * a later re-enable doesn't land silently capped. Fails open on Redis
   * trouble: NotificationService.send has its own Redis dependencies, so this
   * only matters for narrow partial outages.
   */
  async mayNotify(
    recipient: string,
    type: string,
    limit: RateLimit,
  ): Promise<boolean> {
    if (!(await this.preferences.isEnabled(recipient, type))) {
      return false;
    }
    let result: { count: number; capped: boolean };
    try {
      result = await this.redis.incrementWithCap(
        `notif:rate:${type}:${recipient}`,
        limit.windowSec,
        limit.cap,
      );
    } catch (rateError) {
      this.logger.warn(
        `${type} rate-cap check failed for ${recipient} — failing open: ${(rateError as Error).message}`,
      );
      return true;
    }
    if (!result.capped) {
      return true;
    }
    // Log once per window, on the first dropped event.
    if (result.count === limit.cap + 1) {
      this.logger.warn(
        `${type} rate cap hit for ${recipient} (${limit.cap}/${limit.windowSec}s) — further notifications dropped until the window resets`,
      );
    }
    return false;
  }
}
