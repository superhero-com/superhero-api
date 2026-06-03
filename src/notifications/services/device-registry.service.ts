import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceToken } from '../entities/device-token.entity';
import { NotificationRedisService } from './notification-redis.service';
import { REDIS_KEYS } from '../notifications.constants';

/**
 * Maintains `notif:has-devices`, the O(1) Redis SET the live trigger consults for
 * every chain transaction. The set is an optimization: a wrong/empty set causes at
 * most MISSED notifications (never spurious sends), and `hasDevices()` falls back to
 * a DB check when Redis is unavailable. Rebuilt from the DB on boot and hourly.
 */
@Injectable()
export class DeviceRegistryService implements OnModuleInit {
  private readonly logger = new Logger(DeviceRegistryService.name);

  constructor(
    private readonly redis: NotificationRedisService,
    @InjectRepository(DeviceToken)
    private readonly deviceRepository: Repository<DeviceToken>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.rebuild();
  }

  /**
   * Distinct addresses with at least one registered device — every account a
   * push can actually reach. Single source of truth for both the Redis-set
   * rebuild here and the "send to all" announcement fan-out (DeviceService
   * delegates to this).
   */
  async listAddressesWithDevice(): Promise<string[]> {
    const rows = await this.deviceRepository
      .createQueryBuilder('d')
      .select('DISTINCT d.address', 'address')
      .getRawMany<{ address: string }>();
    return rows.map((r) => r.address).filter(Boolean);
  }

  /**
   * REPLACE the Redis set with the current DB-derived address set via
   * `redis.replaceSet` (an atomic Lua EVAL: DEL + chunked SADD). Stale members
   * from a previous run (devices deleted while the API was down, or a Redis
   * flush) are dropped, while any concurrent `addAddress()` SADD that lands
   * mid-rebuild is preserved by the EVAL's atomic boundary.
   */
  async rebuild(): Promise<void> {
    try {
      const addresses = await this.listAddressesWithDevice();
      await this.redis.replaceSet(REDIS_KEYS.hasDevices, addresses);
      this.logger.log(
        `Rebuilt device-registry set with ${addresses.length} address(es)`,
      );
    } catch (error) {
      this.logger.error(
        'Failed to rebuild device-registry set',
        error as Error,
      );
    }
  }

  /**
   * Hourly defense-in-depth rebuild. Catches drift from operations the API
   * didn't initiate (DBA hand-edits, manual SQL), and re-seeds the set if
   * Redis was flushed/failed-over while the API was running.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledRebuild(): Promise<void> {
    await this.rebuild();
  }

  /** Hot-path gate. Falls back to DB if Redis is down so we degrade, not fail. */
  async hasDevices(address: string): Promise<boolean> {
    try {
      return await this.redis.sIsMember(REDIS_KEYS.hasDevices, address);
    } catch (error) {
      this.logger.warn(
        `Redis gate unavailable, falling back to DB for ${address}`,
        error as Error,
      );
      const count = await this.deviceRepository.count({ where: { address } });
      return count > 0;
    }
  }

  async addAddress(address: string): Promise<void> {
    await this.redis.sAdd(REDIS_KEYS.hasDevices, [address]);
  }

  async removeAddress(address: string): Promise<void> {
    await this.redis.sRem(REDIS_KEYS.hasDevices, address);
  }
}
