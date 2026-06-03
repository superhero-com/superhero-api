import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CONFIG } from '@/configs';
import { ACTIVE_NETWORK_ID } from '@/configs/network';
import { AnnouncementSchedulerService } from './announcement-scheduler.service';
import announcementsConfig from '../announcements.config';

/**
 * Channel name for the admin → API "wake" signal. Includes the network id so
 * multiple networks sharing the same Redis instance don't trigger each other.
 * Pub/sub channels do NOT inherit ioredis `keyPrefix`, so we namespace manually.
 *
 * Read directly from `ACTIVE_NETWORK_ID` (= `process.env.AE_NETWORK_ID || 'ae_mainnet'`),
 * NOT from `REDIS_CONFIG.keyPrefix`. They coincide today, but customizing
 * `keyPrefix` for a Redis namespace migration would silently split this channel
 * away from the admin's (which reads `AE_NETWORK_ID` directly) and break the
 * immediate-dispatch contract with no log line indicating why.
 */
export const ANNOUNCEMENT_WAKE_CHANNEL = `superhero:announcements:wake:${ACTIVE_NETWORK_ID}`;

/**
 * Subscribes to the wake channel and triggers an immediate scheduler tick when a
 * message arrives. Used by the admin to deliver individual notifications without
 * waiting for the cron interval. The scheduler's reentrancy guard handles
 * concurrent calls. If the subscriber is down or Redis is unreachable, the cron
 * (every 5 min by default) is the fallback — no announcement is ever lost.
 */
@Injectable()
export class AnnouncementSignalService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AnnouncementSignalService.name);
  private subscriber: Redis | null = null;

  constructor(
    private readonly scheduler: AnnouncementSchedulerService,
    @Inject(announcementsConfig.KEY)
    private readonly config: ConfigType<typeof announcementsConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    // Dedicated subscriber connection — ioredis pub/sub locks the connection
    // into subscribe mode, so this MUST NOT share the regular command client.
    this.subscriber = new Redis(REDIS_CONFIG);
    this.subscriber.on('error', (err) =>
      this.logger.error('Subscriber connection error', err),
    );
    try {
      await this.subscriber.subscribe(ANNOUNCEMENT_WAKE_CHANNEL);
      this.subscriber.on('message', async (channel) => {
        if (channel !== ANNOUNCEMENT_WAKE_CHANNEL) return;
        try {
          await this.scheduler.tick();
        } catch (e) {
          this.logger.error('Wake-triggered tick failed', e as Error);
        }
      });
      this.logger.log(
        `Subscribed to ${ANNOUNCEMENT_WAKE_CHANNEL} for immediate dispatch`,
      );
    } catch (e) {
      this.logger.error(
        `Failed to subscribe to ${ANNOUNCEMENT_WAKE_CHANNEL} — falling back to cron only`,
        e as Error,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        // best-effort on shutdown
      }
      this.subscriber = null;
    }
  }
}
