import { encode, Encoding, MemoryAccount } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { parseProfilePrivateKeyBytes } from './profile-private-key.util';

@Injectable()
export class ProfileSpendQueueService {
  private readonly queuesByKey = new Map<string, Promise<void>>();
  private readonly accountsByKey = new Map<string, MemoryAccount>();
  private readonly accountInitErrorsByKey = new Map<string, Error>();

  async enqueueSpend(privateKey: string, work: () => Promise<void>): Promise<void> {
    const currentQueue = this.queuesByKey.get(privateKey) || Promise.resolve();
    const current = currentQueue.then(work, work);
    this.queuesByKey.set(
      privateKey,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  getRewardAccount(privateKey: string, privateKeyEnvName: string): MemoryAccount {
    const cached = this.accountsByKey.get(privateKey);
    if (cached) {
      return cached;
    }
    const existingError = this.accountInitErrorsByKey.get(privateKey);
    if (existingError) {
      throw existingError;
    }

    try {
      const normalized = this.normalizePrivateKey(privateKey, privateKeyEnvName);
      const account = new MemoryAccount(normalized);
      this.accountsByKey.set(privateKey, account);
      return account;
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      this.accountInitErrorsByKey.set(privateKey, normalizedError);
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
