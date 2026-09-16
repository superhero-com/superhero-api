import { encode, Encoding, MemoryAccount } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseProfilePrivateKeyBytes } from './profile-private-key.util';

/**
 * Serializes reward spends per on-chain wallet so concurrent payouts cannot
 * collide on the account nonce and strand a transaction.
 *
 * Two layers guard the account nonce:
 *  - a PROCESS-LOCAL in-memory promise chain, keyed by the normalized wallet key;
 *  - a CROSS-PROCESS Postgres session advisory lock, keyed by the wallet's public
 *    `ak_` address, taken inside that chain (see `runWithWalletAdvisoryLock`).
 *
 * The advisory lock is what makes a horizontally scaled deployment safe: today's
 * deploy runs one container per environment, but the Dockerfile already expects
 * replicas and the client can change the topology without telling us. Two pods
 * sharing a reward wallet would otherwise broadcast at the same nonce. The
 * DB-atomic claim/`orIgnore` guards still prevent double-PAYING across instances;
 * this adds nonce serialization across them too.
 */
@Injectable()
export class ProfileSpendQueueService {
  private readonly logger = new Logger(ProfileSpendQueueService.name);
  private readonly queuesByKey = new Map<string, Promise<void>>();
  private readonly accountsByKey = new Map<string, MemoryAccount>();
  private readonly accountInitErrorsByKey = new Map<string, Error>();

  /** Advisory-lock namespace (int4) for reward-wallet payout serialization. */
  private static readonly PAYOUT_LOCK_NAMESPACE = 0x70727764; // 'prwd'
  /**
   * Bound on how long a spend WAITS to acquire another pod's wallet lock. A
   * timeout throws before `spend`, so the caller records `payout_send_failed`
   * and backs off (a safe retry) rather than piling up. The lock is HELD for the
   * whole spend — including the post-broadcast mining poll — which is the point.
   */
  private static readonly PAYOUT_LOCK_TIMEOUT_MS = 30_000;

  constructor(private readonly dataSource: DataSource) {}

  async enqueueSpend(
    privateKey: string,
    work: () => Promise<void>,
  ): Promise<void> {
    // Serialize by the NORMALIZED key, not the raw string: two env values that
    // encode the same wallet differently (e.g. a 32-byte seed vs the 64-byte
    // secret key, or differing case/prefix) must share ONE queue. Two queues for
    // the same on-chain account would let concurrent spends collide on the
    // account nonce and strand a payout.
    const queueKey = this.queueKeyFor(privateKey);
    const currentQueue = this.queuesByKey.get(queueKey) || Promise.resolve();
    // Take the cross-process lock INSIDE the chain: acquiring it only when this
    // spend's turn comes up means a queued spend never holds a pool connection
    // (or the lock) while it waits behind an earlier one for the same wallet.
    const lockedWork = () => this.runWithWalletAdvisoryLock(privateKey, work);
    const current = currentQueue.then(lockedWork, lockedWork);
    this.queuesByKey.set(
      queueKey,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  /**
   * Run `work` while holding a Postgres session advisory lock keyed by the
   * reward wallet's public `ak_` address, on a DEDICATED QueryRunner. A dedicated
   * runner is mandatory: `dataSource.query` can run the unlock on a different
   * pooled connection, leaking the lock so every later payout from that wallet
   * hangs. The key is the public address — never the private key or anything
   * derived from it.
   */
  private async runWithWalletAdvisoryLock(
    privateKey: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const lockKey = this.getRewardAccount(
      privateKey,
      'PROFILE_REWARD_PRIVATE_KEY',
    ).address;
    const queryRunner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await queryRunner.connect();
      // Session-scoped to this runner's connection; released with it. Bounds only
      // the wait to acquire, not how long the lock is held.
      await queryRunner.query(
        `SET lock_timeout = '${ProfileSpendQueueService.PAYOUT_LOCK_TIMEOUT_MS}ms'`,
      );
      await queryRunner.query(
        'SELECT pg_advisory_lock($1::int4, hashtext($2))',
        [ProfileSpendQueueService.PAYOUT_LOCK_NAMESPACE, lockKey],
      );
      locked = true;
      await work();
    } finally {
      if (locked) {
        try {
          await queryRunner.query(
            'SELECT pg_advisory_unlock($1::int4, hashtext($2))',
            [ProfileSpendQueueService.PAYOUT_LOCK_NAMESPACE, lockKey],
          );
        } catch (unlockError) {
          this.logger.error(
            'Failed to release reward-wallet payout advisory lock',
            unlockError instanceof Error
              ? unlockError.stack
              : String(unlockError),
          );
        }
      }
      await queryRunner.release();
    }
  }

  /**
   * Stable per-account queue key. Falls back to the raw key only when it cannot
   * be normalized (a malformed key surfaces its real error later in `work` via
   * getRewardAccount).
   */
  private queueKeyFor(privateKey: string): string {
    try {
      return this.normalizePrivateKey(privateKey, 'PROFILE_REWARD_PRIVATE_KEY');
    } catch {
      return privateKey;
    }
  }

  getRewardAccount(
    privateKey: string,
    privateKeyEnvName: string,
  ): MemoryAccount {
    // Cache by the SAME normalized key the queue serializes on, so two env
    // encodings of one wallet resolve to a single cached account (and a single
    // cached init error) rather than splitting into two.
    const cacheKey = this.queueKeyFor(privateKey);
    const cached = this.accountsByKey.get(cacheKey);
    if (cached) {
      return cached;
    }
    const existingError = this.accountInitErrorsByKey.get(cacheKey);
    if (existingError) {
      throw existingError;
    }

    try {
      const normalized = this.normalizePrivateKey(
        privateKey,
        privateKeyEnvName,
      );
      const account = new MemoryAccount(normalized);
      this.accountsByKey.set(cacheKey, account);
      return account;
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      this.accountInitErrorsByKey.set(cacheKey, normalizedError);
      throw normalizedError;
    }
  }

  private normalizePrivateKey(
    privateKey: string,
    privateKeyEnvName: string,
  ): `sk_${string}` {
    try {
      const keyBytes = parseProfilePrivateKeyBytes(privateKey);
      const seed = keyBytes.length === 64 ? keyBytes.subarray(0, 32) : keyBytes;
      return encode(seed, Encoding.AccountSecretKey) as `sk_${string}`;
    } catch {
      throw new Error(
        `${privateKeyEnvName} must be a 32-byte seed or 64-byte secret key`,
      );
    }
  }
}
