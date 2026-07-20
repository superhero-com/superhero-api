import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { randomBytes } from 'crypto';
import notificationsConfig from '../notifications.config';
import { REDIS_KEYS } from '../notifications.constants';
import { NotificationRedisService } from './notification-redis.service';

export interface MintedSession {
  token: string;
  expiresAt: Date;
}

/**
 * Bearer sessions for the web feed, bootstrapped from a single æternity
 * signature (verified by DeviceChallengeService) — the SIWE-style pattern that
 * avoids re-signing on every poll. A session is an opaque random token mapped to
 * its owner address in Redis with a TTL; it authorizes feed reads, mark-read,
 * and the socket handshake.
 *
 * Opaque + server-side (not a self-contained JWT) so a session is instantly
 * revocable and carries no signing-key surface. Tokens are network-namespaced
 * via REDIS_CONFIG.keyPrefix, like every other key in this module.
 */
@Injectable()
export class FeedSessionService {
  constructor(
    private readonly redis: NotificationRedisService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  /** Issue a fresh session for an address whose control was just proven. */
  async mint(address: string): Promise<MintedSession> {
    const token = randomBytes(32).toString('hex');
    const ttlMs = this.config.feedSessionTtlMs;
    await this.redis.setEx(REDIS_KEYS.feedSession(token), address, ttlMs);
    return { token, expiresAt: new Date(Date.now() + ttlMs) };
  }

  /** Resolve a bearer token to its owner address, or null if absent/expired. */
  async resolve(token: string): Promise<string | null> {
    if (!token) {
      return null;
    }
    return this.redis.get(REDIS_KEYS.feedSession(token));
  }

  /** Invalidate a session (logout). */
  async revoke(token: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.feedSession(token));
  }
}
