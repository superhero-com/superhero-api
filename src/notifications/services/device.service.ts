import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { DeviceToken } from '../entities/device-token.entity';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceChallengeService } from './device-challenge.service';
import { RegisterDeviceDto } from '../dto/register-device.dto';
import { UnregisterDeviceDto } from '../dto/unregister-device.dto';
import notificationsConfig from '../notifications.config';

/**
 * Owns the `device_tokens` table: signed registration, unregistration, the fan-out
 * token lookup, and dead-token pruning. Keeps the Redis device-registry set in sync.
 */
@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);

  constructor(
    @InjectRepository(DeviceToken)
    private readonly deviceRepository: Repository<DeviceToken>,
    private readonly registry: DeviceRegistryService,
    private readonly challenges: DeviceChallengeService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  /**
   * Verify the signed challenge (bound to the push token), then atomically
   * register-or-refresh the device. The previous version did findOne+upsert
   * across two statements, which left a TOCTOU window where two concurrent
   * registers for the same token under different addresses could both observe
   * existing===null and then race in the upsert — the second writer would
   * silently overwrite the first's address.
   *
   * We close that window with a single conditional INSERT … ON CONFLICT DO UPDATE
   * whose WHERE clause refuses the update when the existing row's address
   * differs. On Postgres this is one atomic statement; if RETURNING comes back
   * empty, we know the conflict landed on a row owned by someone else.
   */
  async register(dto: RegisterDeviceDto): Promise<void> {
    await this.challenges.verifyAndConsume(
      dto.nonce,
      dto.address,
      dto.expoPushToken,
      dto.signature,
    );

    const rows = await this.deviceRepository.query<{ address: string }[]>(
      `INSERT INTO device_tokens
         (expo_push_token, address, platform, app_version, device_id,
          last_seen_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())
       ON CONFLICT (expo_push_token) DO UPDATE
         SET address       = EXCLUDED.address,
             platform      = EXCLUDED.platform,
             app_version   = EXCLUDED.app_version,
             device_id     = EXCLUDED.device_id,
             last_seen_at  = now(),
             updated_at    = now()
         WHERE device_tokens.address = EXCLUDED.address
       RETURNING address`,
      [
        dto.expoPushToken,
        dto.address,
        dto.platform,
        dto.appVersion ?? null,
        dto.deviceId ?? null,
      ],
    );

    if (rows.length === 0) {
      // The token exists but is owned by a different address; the WHERE clause
      // suppressed the UPDATE and the INSERT was blocked by the conflict.
      throw new ConflictException(
        'Push token is already registered to a different account',
      );
    }

    await this.registry.addAddress(dto.address);
  }

  /**
   * Signature-gated unregister. The DELETE-and-distinguish is one atomic CTE
   * so there's no TOCTOU window: the previous two-statement (DELETE then
   * `exist()`) version could see a concurrent register insert a fresh row
   * between the two queries and return a spurious 409 to a caller whose
   * unregister was legitimately a no-op. `Repository.exist()` is also
   * deprecated in TypeORM 0.3 — the CTE form replaces both concerns at once.
   *
   * Result interpretation:
   *   - `deleted > 0`                      → success, cleanup if last device
   *   - `deleted = 0` and no existing row  → idempotent success (no such token)
   *   - `deleted = 0` and existing row     → 409 (owned by a different address)
   */
  async unregister(dto: UnregisterDeviceDto): Promise<void> {
    await this.challenges.verifyAndConsumeForUnlink(
      dto.nonce,
      dto.address,
      dto.expoPushToken,
      dto.signature,
    );

    const rows = await this.deviceRepository.query<
      { deleted: number; existing_address: string | null }[]
    >(
      `WITH deleted AS (
         DELETE FROM device_tokens
           WHERE expo_push_token = $1 AND address = $2
           RETURNING address
       )
       SELECT
         (SELECT COUNT(*) FROM deleted)::int        AS deleted,
         (SELECT address FROM device_tokens
            WHERE expo_push_token = $1)             AS existing_address`,
      [dto.expoPushToken, dto.address],
    );
    const { deleted, existing_address } = rows[0] ?? {
      deleted: 0,
      existing_address: null,
    };

    if (deleted === 0) {
      if (existing_address !== null) {
        throw new ConflictException(
          'Push token is registered to a different account',
        );
      }
      return; // idempotent — token didn't exist
    }

    await this.cleanupAddressIfEmpty(dto.address);
  }

  /** Reactive cleanup of a dead token reported by Expo (DeviceNotRegistered). */
  async pruneToken(expoPushToken: string): Promise<void> {
    await this.removeToken(expoPushToken);
  }

  /** Tokens to push to for a recipient address (the only hot-path DB query). */
  async getActiveTokens(address: string): Promise<string[]> {
    const rows = await this.deviceRepository.find({
      where: { address },
      select: ['expo_push_token'],
    });
    return rows.map((r) => r.expo_push_token);
  }

  /**
   * Distinct addresses with at least one registered device — i.e. every account a
   * push can actually reach. Used for "send to all" announcement fan-out.
   * Delegates to the registry, which owns the canonical query (also used to
   * rebuild the hot-path device gate), so the two can't drift.
   */
  async distinctAddressesWithDevice(): Promise<string[]> {
    return this.registry.listAddressesWithDevice();
  }

  /**
   * Daily sweep of abandoned installs: devices whose `last_seen_at` is older
   * than `staleDeviceDays` (the app re-registers periodically as a heartbeat,
   * so a long-silent row is a removed/wiped install Expo may never surface a
   * DeviceNotRegistered receipt for). Reactive pruning only catches tokens we
   * actually push to; this catches the rest so the fan-out set and the
   * `has-devices` gate don't accumulate dead addresses indefinitely.
   *
   * Multi-replica safe: the lock + delete run in one transaction sharing a
   * single connection, with `pg_try_advisory_xact_lock` (auto-released at
   * commit), so only one replica does the delete per tick. Mirrors
   * `DeviceChallengeService.cleanupExpired`.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupStaleDevices(): Promise<void> {
    // 32-bit magic key ("ndev" — notifDev), distinct from the challenge sweep's.
    const LOCK_KEY = 0x6e646576;
    const cutoff = new Date(
      Date.now() - this.config.staleDeviceDays * 24 * 60 * 60 * 1000,
    );
    try {
      const deleted = await this.deviceRepository.manager.transaction(
        async (em) => {
          const lockRows = await em.query<
            { pg_try_advisory_xact_lock: boolean }[]
          >(
            'SELECT pg_try_advisory_xact_lock($1) AS pg_try_advisory_xact_lock',
            [LOCK_KEY],
          );
          if (!lockRows?.[0]?.pg_try_advisory_xact_lock) {
            return 0;
          }
          const result = await em.delete(DeviceToken, {
            last_seen_at: LessThan(cutoff),
          });
          return result.affected ?? 0;
        },
      );
      if (deleted > 0) {
        this.logger.log(`Pruned ${deleted} stale device(s)`);
        // Some addresses may now have zero devices; resync the hot-path gate.
        await this.registry.rebuild();
      }
    } catch (error) {
      this.logger.error('Failed to clean up stale devices', error as Error);
    }
  }

  private async removeToken(expoPushToken: string): Promise<void> {
    const existing = await this.deviceRepository.findOne({
      where: { expo_push_token: expoPushToken },
    });
    if (!existing) {
      return;
    }
    await this.deviceRepository.delete({ expo_push_token: expoPushToken });
    await this.cleanupAddressIfEmpty(existing.address);
  }

  private async cleanupAddressIfEmpty(address: string): Promise<void> {
    const count = await this.deviceRepository.count({ where: { address } });
    if (count === 0) {
      await this.registry.removeAddress(address);
    }
  }
}
