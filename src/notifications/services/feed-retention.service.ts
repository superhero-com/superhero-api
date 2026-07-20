import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import notificationsConfig from '../notifications.config';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationFeedService } from './notification-feed.service';

/**
 * Bounds the per-recipient feed: prunes old read rows and caps rows per address,
 * so the central activity log a decentralized app shouldn't hoard stays small.
 *
 * Multi-replica safety mirrors DeviceChallengeService.cleanupExpired: the lock +
 * deletes run in one transaction over a single connection via
 * `pg_try_advisory_xact_lock`, which auto-releases at commit. Replicas race for
 * the lock; only one prunes per tick.
 */
@Injectable()
export class FeedRetentionService {
  private readonly logger = new Logger(FeedRetentionService.name);

  constructor(
    @InjectRepository(NotificationRecord)
    private readonly repo: Repository<NotificationRecord>,
    private readonly feed: NotificationFeedService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async prune(): Promise<void> {
    // 32-bit magic key ("nfed" — notifFeed), distinct from the challenge lock.
    const LOCK_KEY = 0x6e666564;
    try {
      await this.repo.manager.transaction(async (em) => {
        const lockRows = await em.query<
          { pg_try_advisory_xact_lock: boolean }[]
        >('SELECT pg_try_advisory_xact_lock($1) AS pg_try_advisory_xact_lock', [
          LOCK_KEY,
        ]);
        if (!lockRows?.[0]?.pg_try_advisory_xact_lock) {
          return;
        }
        await this.feed.prune(
          em,
          this.config.feedRetentionDays,
          this.config.feedMaxRowsPerAddress,
          this.config.feedRetentionDeleteBatchSize,
        );
      });
    } catch (error) {
      this.logger.error('Failed to prune notification feed', error as Error);
    }
  }
}
