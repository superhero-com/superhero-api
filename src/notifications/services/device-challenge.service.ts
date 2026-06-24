import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { verifyAeAddressSignature } from '@/profile/services/profile-signature.util';
import { DeviceChallenge } from '../entities/device-challenge.entity';
import {
  buildDeviceLinkMessage,
  buildDeviceUnlinkMessage,
  buildFeedSessionMessage,
  buildPreferencesUpdateMessage,
} from '../notifications.constants';
import { buildRoomMuteMessage } from '@/token-gated-rooms/notifications/room-mute.message';
import notificationsConfig from '../notifications.config';

export interface IssuedChallenge {
  nonce: string;
  expiresAt: Date;
}

/**
 * Issues and verifies the signed device-registration challenge. Verification proves
 * the caller controls the `ak_` address by checking a signature over the exact
 * server-issued message, then atomically consumes the challenge (single-use).
 */
@Injectable()
export class DeviceChallengeService {
  private readonly logger = new Logger(DeviceChallengeService.name);

  constructor(
    @InjectRepository(DeviceChallenge)
    private readonly challengeRepository: Repository<DeviceChallenge>,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  /**
   * Issue a fresh single-use nonce for `address`. The returned `nonce` is what the
   * mobile app must echo back in the matching POST. The exact message to sign is
   * intent-specific and is rebuilt on the verify side — clients reproduce it
   * locally (see `agent/mobile/tasks/`), so we no longer return it here (it would
   * be wrong for any intent that doesn't bind to the device-link message).
   */
  async issue(address: string): Promise<IssuedChallenge> {
    // Per-address DoS guard: prune any expired/consumed-old rows opportunistically,
    // then refuse if too many pending live ones remain.
    await this.pruneAddress(address);
    const pending = await this.challengeRepository.count({
      where: {
        address,
        consumed_at: IsNull(),
        expires_at: MoreThan(new Date()),
      },
    });
    if (pending >= this.config.challengeMaxPendingPerAddress) {
      throw new HttpException(
        'Too many pending challenges for this address',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + this.config.challengeTtlMs);
    await this.challengeRepository.save({
      nonce,
      address,
      expires_at: expiresAt,
      consumed_at: null,
    });
    return { nonce, expiresAt };
  }

  /**
   * Validates challenge existence/expiry/ownership, verifies the signature against
   * the **device-link** message (which now binds to the push token too), and
   * atomically marks the challenge consumed. Throws on any failure.
   */
  async verifyAndConsume(
    nonce: string,
    address: string,
    expoPushToken: string,
    signature: string,
  ): Promise<void> {
    await this.verifyWithMessage(
      nonce,
      address,
      signature,
      buildDeviceLinkMessage(address, expoPushToken, nonce),
    );
  }

  /**
   * Same atomic verify, but against the **device-unlink** message. Without this,
   * any party that knows a push token could DoS the device's notifications.
   */
  async verifyAndConsumeForUnlink(
    nonce: string,
    address: string,
    expoPushToken: string,
    signature: string,
  ): Promise<void> {
    await this.verifyWithMessage(
      nonce,
      address,
      signature,
      buildDeviceUnlinkMessage(address, expoPushToken, nonce),
    );
  }

  /**
   * Same atomic verify, but against the **preferences-update** message (which
   * binds to the canonical hash of the {type, enabled} delta). Shared nonce
   * table; distinct message format prevents cross-replay between intents AND
   * prevents the body from being swapped on a captured nonce.
   */
  async verifyAndConsumeForPreferences(
    nonce: string,
    address: string,
    preferences: ReadonlyArray<{ type: string; enabled: boolean }>,
    signature: string,
  ): Promise<void> {
    await this.verifyWithMessage(
      nonce,
      address,
      signature,
      buildPreferencesUpdateMessage(address, nonce, preferences),
    );
  }

  /**
   * Same atomic verify, but against the **room-mute** message (Task 13). The
   * shared nonce table is reused; the distinct intent line (`Superhero Rooms\nMute
   * <saleAddress> for <address>`) plus the body hash over `(muted, mute_all)`
   * prevent cross-replay from the prefs/device intents AND prevent the mute flags
   * (or the target room) from being swapped on a captured nonce+sig.
   */
  async verifyAndConsumeForRoomMute(
    nonce: string,
    address: string,
    saleAddress: string,
    muted: boolean,
    muteAll: boolean | undefined,
    signature: string,
  ): Promise<void> {
    await this.verifyWithMessage(
      nonce,
      address,
      signature,
      buildRoomMuteMessage(address, nonce, saleAddress, muted, muteAll),
    );
  }

  /**
   * Same atomic verify, but against the **feed-session** message. The verified
   * signature is the one-time proof of address control that the caller exchanges
   * for a bearer session (see FeedSessionService); the session then authorizes
   * feed reads and the socket handshake without re-signing per request.
   */
  async verifyAndConsumeForSession(
    nonce: string,
    address: string,
    signature: string,
  ): Promise<void> {
    await this.verifyWithMessage(
      nonce,
      address,
      signature,
      buildFeedSessionMessage(address, nonce),
    );
  }

  private async verifyWithMessage(
    nonce: string,
    address: string,
    signature: string,
    message: string,
  ): Promise<void> {
    const challenge = await this.challengeRepository.findOne({
      where: { nonce },
    });

    if (!challenge || challenge.address !== address) {
      throw new BadRequestException('Invalid challenge');
    }
    if (challenge.consumed_at) {
      throw new BadRequestException('Challenge already used');
    }
    if (challenge.expires_at.getTime() < Date.now()) {
      throw new GoneException('Challenge expired');
    }

    if (!verifyAeAddressSignature(address, message, signature)) {
      throw new UnauthorizedException('Invalid signature');
    }

    // Atomic single-use guard: only the first concurrent caller flips consumed_at.
    const result = await this.challengeRepository.update(
      { nonce, consumed_at: IsNull() },
      { consumed_at: new Date() },
    );
    if (result.affected !== 1) {
      throw new BadRequestException('Challenge already used');
    }
  }

  /**
   * Per-address opportunistic prune. Drops expired challenges and consumed
   * challenges older than 1 hour for this address. Keeps `issue()` from being
   * a slow accumulator on the same address.
   */
  private async pruneAddress(address: string): Promise<void> {
    const now = new Date();
    const consumedCutoff = new Date(Date.now() - 60 * 60 * 1000);
    await this.challengeRepository
      .createQueryBuilder()
      .delete()
      .where('address = :address', { address })
      .andWhere(
        '(expires_at < :now OR (consumed_at IS NOT NULL AND consumed_at < :consumedCutoff))',
        { now, consumedCutoff },
      )
      .execute();
  }

  /**
   * Sweep expired challenges every 10 minutes (was: daily). With per-address rate
   * capping in `issue()` the table stays small, but a runaway client (or test)
   * can still create thousands of rows in a single 10-minute window — keep this
   * tick frequent enough that the table never grows large in production.
   *
   * Multi-replica safety: the lock+delete pair runs inside a single transaction
   * so both statements share the same Postgres connection, and we use
   * `pg_advisory_xact_lock`, which auto-releases at commit. The previous design
   * used session-scoped `pg_try_advisory_lock` across separate `repository.query()`
   * calls — those calls take different pool connections, so the unlock could
   * land on a connection that never held the lock and the original session
   * would retain it until that pooled connection was recycled.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async cleanupExpired(): Promise<void> {
    // 32-bit magic key ("ncha" — notifChal). Fits inside JS's safe integer
    // range and Postgres bigint. Replicas race for the lock; only one wins
    // per tick, avoiding redundant DELETE pressure on the table.
    const LOCK_KEY = 0x6e636861;
    try {
      await this.challengeRepository.manager.transaction(async (em) => {
        const lockRows = await em.query<
          { pg_try_advisory_xact_lock: boolean }[]
        >('SELECT pg_try_advisory_xact_lock($1) AS pg_try_advisory_xact_lock', [
          LOCK_KEY,
        ]);
        const locked = !!lockRows?.[0]?.pg_try_advisory_xact_lock;
        if (!locked) {
          return;
        }
        await em.delete(DeviceChallenge, {
          expires_at: LessThan(new Date()),
        });
      });
    } catch (error) {
      this.logger.error(
        'Failed to clean up expired challenges',
        error as Error,
      );
    }
  }
}
