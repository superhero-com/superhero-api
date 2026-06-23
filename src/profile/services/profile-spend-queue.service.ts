import { encode, Encoding, MemoryAccount } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { parseProfilePrivateKeyBytes } from './profile-private-key.util';

/**
 * Serializes reward spends per on-chain wallet so concurrent payouts cannot
 * collide on the account nonce and strand a transaction.
 *
 * SCOPE: this guard is PROCESS-LOCAL (an in-memory promise chain). It is
 * sufficient for a single instance. Before arming rewards in a horizontally
 * scaled deployment (multiple pods sharing a reward wallet), front the spend
 * with a cross-process lock (e.g. a Postgres advisory lock keyed by the wallet)
 * or run a single dedicated payout worker — otherwise two pods can broadcast at
 * the same nonce. The DB-atomic claim/`orIgnore` guards still prevent
 * double-PAYING across instances; only nonce serialization is process-local.
 */
@Injectable()
export class ProfileSpendQueueService {
  private readonly queuesByKey = new Map<string, Promise<void>>();
  private readonly accountsByKey = new Map<string, MemoryAccount>();
  private readonly accountInitErrorsByKey = new Map<string, Error>();

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
    const current = currentQueue.then(work, work);
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
