import { REDIS_CONFIG } from '@/configs';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Thin, owned ioredis client for the notification module (set membership for the
 * hot-path device gate, and SET NX dedup markers). Mirrors the pattern used by
 * TokenHoldersLockService. Keys are auto-namespaced per network via REDIS_CONFIG.keyPrefix.
 */
@Injectable()
export class NotificationRedisService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationRedisService.name);
  private readonly redis = new Redis(REDIS_CONFIG);

  constructor() {
    this.redis.on('error', (error) => {
      this.logger.error('Notification Redis connection error', error);
    });
  }

  async sIsMember(key: string, member: string): Promise<boolean> {
    return (await this.redis.sismember(key, member)) === 1;
  }

  async sAdd(key: string, members: string[]): Promise<void> {
    if (members.length > 0) {
      await this.redis.sadd(key, ...members);
    }
  }

  async sRem(key: string, member: string): Promise<void> {
    await this.redis.srem(key, member);
  }

  /**
   * Atomically REPLACE the set at `key` with `members`. Implemented as a single
   * Redis Lua EVAL (DEL key + chunked SADDs) so any concurrent SADD from
   * `addAddress()` that lands between read and write is preserved by the EVAL
   * boundary — Lua scripts run atomically and block other commands. The
   * previous tmp+RENAME implementation had a TOCTOU window where a concurrent
   * register's SADD could be silently overwritten by the RENAME.
   *
   * SADD is chunked inside the script. The naïve `SADD key unpack(ARGV)` form
   * blows Lua's C stack at ~7-8K varargs (`LUAI_MAXCSTACK`) — for a user base
   * with that many device-owning addresses, rebuild() would throw AFTER the
   * DEL had already run, leaving the Redis set empty. The Lua loop here keeps
   * each SADD under the cap while still finishing inside one atomic EVAL.
   *
   * For `members` empty, this collapses to `DEL key` (a no-args SADD is invalid).
   */
  async replaceSet(key: string, members: string[]): Promise<void> {
    if (members.length === 0) {
      await this.redis.del(key);
      return;
    }
    // KEYS[1] = destination set, ARGV = members. SADD is chunked at 1000
    // entries per call — well below LUAI_MAXCSTACK.
    const script = `
      redis.call('DEL', KEYS[1])
      local chunk = 1000
      for i = 1, #ARGV, chunk do
        local stop = math.min(i + chunk - 1, #ARGV)
        redis.call('SADD', KEYS[1], unpack(ARGV, i, stop))
      end
      return 1
    `;
    await this.redis.eval(script, 1, key, ...members);
  }

  /** Atomic SET key val PX ttl NX. Returns true iff the key was newly set. */
  async tryAcquire(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  /**
   * Atomic INCR + first-time EXPIRE used as a fixed-window rate cap. The Lua
   * script ensures the EXPIRE-on-first-hit and the INCR are observed together,
   * so an unlucky restart between separate INCR/EXPIRE commands can't leave
   * the key without a TTL (which would otherwise turn the cap into a one-shot
   * gate that never resets).
   *
   * Returns `{ count, capped }` — `count` is the post-increment counter for
   * the current window, `capped` is true once `count > cap`. Callers should
   * abort their notification dispatch when `capped` is true.
   */
  async incrementWithCap(
    key: string,
    ttlSec: number,
    cap: number,
  ): Promise<{ count: number; capped: boolean }> {
    const script = `
      local c = redis.call('INCR', KEYS[1])
      if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      return c
    `;
    // ioredis can return Lua integer replies as either `number` or `string`
    // depending on protocol mode / client configuration; coerce defensively
    // so the boundary checks downstream do strict-equality on a real number.
    const raw = await this.redis.eval(script, 1, key, ttlSec);
    const count =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number.parseInt(raw, 10)
          : NaN;
    if (!Number.isFinite(count)) {
      throw new Error(
        `incrementWithCap: unexpected EVAL return shape (${typeof raw})`,
      );
    }
    return { count, capped: count > cap };
  }

  async setEx(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, 'PX', ttlMs);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // ignore
    }
  }
}
