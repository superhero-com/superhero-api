import { REDIS_CONFIG } from '@/configs';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

@Injectable()
export class TokenHoldersLockService implements OnModuleDestroy {
  private readonly logger = new Logger(TokenHoldersLockService.name);
  private readonly redis = new Redis(REDIS_CONFIG);
  private readonly lockTtlMs = Number(
    process.env.SYNC_TOKEN_HOLDERS_LOCK_TTL_MS || 240_000,
  );

  async acquireLock(saleAddress: string): Promise<string | null> {
    const ownerToken = randomUUID();
    const key = this.getLockKey(saleAddress);
    const result = await this.redis.set(
      key,
      ownerToken,
      'PX',
      this.lockTtlMs,
      'NX',
    );

    if (result !== 'OK') {
      return null;
    }

    return ownerToken;
  }

  async releaseLock(saleAddress: string, ownerToken: string): Promise<boolean> {
    const key = this.getLockKey(saleAddress);

    try {
      const result = await this.redis.eval(
        `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        else
          return 0
        end
        `,
        1,
        key,
        ownerToken,
      );
      return Number(result) === 1;
    } catch (error: any) {
      this.logger.error(
        `Failed to release lock for ${saleAddress}`,
        error,
        error.stack,
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      //
    }
  }

  private getLockKey(saleAddress: string): string {
    return `locks:syncTokenHolders:${saleAddress}`;
  }
}
