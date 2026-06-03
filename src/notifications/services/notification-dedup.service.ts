import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import notificationsConfig from '../notifications.config';
import { REDIS_KEYS } from '../notifications.constants';
import { NotificationRedisService } from './notification-redis.service';

/**
 * Idempotency via Redis SET NX. The first caller for a logical key wins; subsequent
 * callers within the TTL are told to skip. Collapses queue retries, duplicate
 * observations, and reorg replays into at-most-once delivery per logical key.
 */
@Injectable()
export class NotificationDedupService {
  constructor(
    private readonly redis: NotificationRedisService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  /**
   * @param logicalKey e.g. `incoming-transfer:<txHash>:<address>`
   * @returns true if this caller may proceed; false if already handled.
   */
  async tryAcquire(logicalKey: string): Promise<boolean> {
    return this.redis.tryAcquire(
      REDIS_KEYS.dedup(logicalKey),
      this.config.dedupTtlMs,
    );
  }

  /**
   * Drop a previously-acquired marker so the logical notification can be
   * delivered again on a later re-observation. Called when an enqueued send
   * exhausts its retries — otherwise the marker (held for `dedupTtlMs`) would
   * suppress every future attempt, turning a transient Expo outage into a
   * permanent silent drop.
   */
  async release(logicalKey: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.dedup(logicalKey));
  }
}
