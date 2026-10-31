import { shortsRuntimeScope } from './shorts-runtime-scope';
import {
  BeforeApplicationShutdown,
  HttpException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { ShortsRateConfig } from './shorts-rate.config';
import { ShortsChainService } from './shorts-chain.service';

export interface ShortsAdmissionLimits {
  capacity: number;
  leaseMs: number;
  renewMs: number;
}
export interface ShortsAdmissionReservation {
  signal: AbortSignal;
  release(): Promise<void>;
}
interface Lease {
  id: string;
  keys: string[];
  controller: AbortController;
  deadline: number;
  expiry?: NodeJS.Timeout;
  renewal?: NodeJS.Timeout;
  renewing?: Promise<void>;
  closed: boolean;
}
const clock = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
`;
const acquire =
  clock +
  `
redis.call('SET',KEYS[3],ARGV[4],'NX')
if redis.call('GET',KEYS[3]) ~= ARGV[4] then return -3 end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if redis.call('EXISTS',KEYS[2]) == 1 then return -2 end
if redis.call('ZCARD',KEYS[1]) >= tonumber(ARGV[2]) then return -1 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[3]),ARGV[1])
redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[3])*2)
redis.call('SET',KEYS[2],ARGV[1],'PX',ARGV[3])
return 1
`;
const renew =
  clock +
  `
if redis.call('GET',KEYS[3]) ~= ARGV[3]
  or redis.call('GET',KEYS[2]) ~= ARGV[1]
  or tonumber(redis.call('ZSCORE',KEYS[1],ARGV[1]) or '0') <= now then return 0 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[2]),ARGV[1])
redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[2])*2)
redis.call('PEXPIRE',KEYS[2],ARGV[2])
return 1
`;
const release = `
redis.call('ZREM',KEYS[1],ARGV[1])
if redis.call('GET',KEYS[2]) == ARGV[1] then redis.call('DEL',KEYS[2]) end
return 1
`;

/** Shared renewable admission used by the upload and media Nest providers. */
export class ShortsTransferAdmissionService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly redis: Redis;
  private readonly limits: ShortsAdmissionLimits;
  private readonly policy: string;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly leases = new Set<Lease>();
  private unavailable = true;
  private stopped = false;
  constructor(
    private readonly config: ShortsRateConfig,
    private readonly chain: ShortsChainService,
    limits: ShortsAdmissionLimits,
    private readonly kind: 'upload' | 'media',
  ) {
    this.limits = limits;
    if (
      !Number.isSafeInteger(this.limits.capacity) ||
      this.limits.capacity < 1 ||
      this.limits.capacity > 64 ||
      !Number.isSafeInteger(this.limits.leaseMs) ||
      this.limits.leaseMs < 1000 ||
      this.limits.leaseMs > 60000 ||
      !Number.isSafeInteger(this.limits.renewMs) ||
      this.limits.renewMs < 100 ||
      this.limits.renewMs >= this.limits.leaseMs / 2
    )
      throw new Error(
        `Invalid ${kind === 'upload' ? 'SHORTS_SHARED_CONCURRENT_UPLOADS' : 'SHORTS_SHARED_CONCURRENT_MEDIA'} or ${kind} lease settings`,
      );
    // A differently configured replica/key must not create a second wallet budget.
    this.policy = createHmac('sha256', config.key)
      .update(
        `shorts-${kind}-v1:${this.limits.capacity}:${this.limits.leaseMs}`,
      )
      .digest('hex');
    this.redis = new Redis({
      ...config.redis,
      keyPrefix: '',
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      commandTimeout: 1000,
      connectTimeout: 1000,
      retryStrategy: (attempt) => Math.min(attempt * 1000, 5000),
    });
    this.redis.on('error', () => {});
    this.redis.on('ready', () => {
      this.unavailable = false;
    });
    this.redis.on('close', () => {
      this.unavailable = true;
    });
  }
  async onApplicationBootstrap() {
    try {
      await this.redis.connect();
      await this.redis.ping();
    } catch {
      this.redis.disconnect();
      throw new Error(`Shared ${this.kind} admission unavailable`);
    }
  }
  private keys(actor: string) {
    const { contract, network } = shortsRuntimeScope(this.chain);
    const { sourceHash } = this.chain.state;
    if (
      process.env.AE_NETWORK_ID !== network ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(contract || '') ||
      !/^[a-f0-9]{64}$/.test(sourceHash || '') ||
      !/^ak_[a-zA-Z0-9]{1,97}$/.test(actor)
    )
      throw new ServiceUnavailableException(
        `Shared ${this.kind} scope unavailable`,
      );
    const scope = createHash('sha256')
      .update(`${network}:${contract}`)
      .digest('hex')
      .slice(0, 32);
    const prefix = `shorts:${this.kind}:v1:{${scope}}`;
    const identity = createHmac('sha256', this.config.key)
      .update(`${this.kind}-actor:${actor}`)
      .digest('hex');
    return [
      `${prefix}:active`,
      `${prefix}:actor:${identity}`,
      `${prefix}:policy`,
    ];
  }
  private async evaluate(
    script: string,
    keys: string[],
    args: (string | number)[],
  ) {
    if (
      this.stopped ||
      this.unavailable ||
      this.redis.status !== 'ready' ||
      this.pending.size >= 32
    )
      throw new ServiceUnavailableException(
        this.kind === 'upload'
          ? 'Uploads are busy. Please try again shortly.'
          : 'Video processing is busy. Please try again shortly.',
      );
    const operation = this.redis.eval(script, keys.length, ...keys, ...args);
    this.pending.add(operation);
    try {
      return await operation;
    } catch {
      if (!this.stopped && !this.unavailable) {
        this.unavailable = true;
        this.redis.disconnect(true);
      }
      throw new ServiceUnavailableException(
        `Shared ${this.kind} capacity is unavailable. Please try again shortly.`,
      );
    } finally {
      this.pending.delete(operation);
    }
  }
  private deadline() {
    return (
      performance.now() +
      this.limits.leaseMs -
      Math.min(1000, this.limits.leaseMs / 4)
    );
  }
  private cancel(lease: Lease) {
    clearTimeout(lease.expiry);
    clearTimeout(lease.renewal);
    lease.controller.abort(
      new ServiceUnavailableException(
        this.kind === 'upload'
          ? 'Upload interrupted. Please resume your upload.'
          : 'Video processing interrupted. Please retry shortly.',
      ),
    );
  }
  private observe(lease: Lease, deadline: number) {
    if (
      this.stopped ||
      lease.closed ||
      lease.controller.signal.aborted ||
      performance.now() >= Math.min(deadline, lease.deadline)
    ) {
      this.cancel(lease);
      return;
    }
    lease.deadline = deadline;
    clearTimeout(lease.expiry);
    lease.expiry = setTimeout(
      () => this.cancel(lease),
      Math.max(1, deadline - performance.now()),
    );
    lease.expiry.unref();
  }
  private schedule(lease: Lease) {
    if (lease.closed || lease.controller.signal.aborted) return;
    lease.renewal = setTimeout(() => {
      lease.renewing = this.renew(lease).finally(() => {
        lease.renewing = undefined;
        this.schedule(lease);
      });
    }, this.limits.renewMs);
    lease.renewal.unref();
  }
  private async renew(lease: Lease) {
    const deadline = this.deadline();
    try {
      if (performance.now() >= lease.deadline) {
        this.cancel(lease);
        return;
      }
      const result = await this.evaluate(renew, lease.keys, [
        lease.id,
        this.limits.leaseMs,
        this.policy,
      ]);
      if (result !== 1) this.cancel(lease);
      else this.observe(lease, deadline);
    } catch {
      this.cancel(lease);
    }
  }
  async acquire(actor: string): Promise<ShortsAdmissionReservation> {
    const lease: Lease = {
      id: randomUUID(),
      keys: this.keys(actor),
      controller: new AbortController(),
      deadline: this.deadline(),
      closed: false,
    };
    const result = await this.evaluate(acquire, lease.keys, [
      lease.id,
      this.limits.capacity,
      this.limits.leaseMs,
      this.policy,
    ]);
    if (result === -2)
      throw new HttpException(
        this.kind === 'upload'
          ? 'Another upload is in progress. Please wait for it to finish.'
          : 'Another video operation is in progress. Please wait for it to finish.',
        429,
      );
    if (result !== 1)
      throw new ServiceUnavailableException(
        `Shared ${this.kind} capacity is busy or temporarily unavailable. Please try again shortly.`,
      );
    this.leases.add(lease);
    this.observe(lease, lease.deadline);
    if (lease.controller.signal.aborted) {
      await this.close(lease);
      throw new ServiceUnavailableException(
        `Shared ${this.kind} operation interrupted. Please try again shortly.`,
      );
    }
    this.schedule(lease);
    return {
      signal: lease.controller.signal,
      release: () => this.close(lease),
    };
  }
  private async close(lease: Lease) {
    if (lease.closed) return;
    lease.closed = true;
    this.cancel(lease);
    await lease.renewing;
    // Owner-matched release cannot delete a replacement wallet reservation.
    await this.evaluate(release, lease.keys.slice(0, 2), [lease.id]).catch(
      () => {},
    );
    this.leases.delete(lease);
  }
  async beforeApplicationShutdown() {
    this.stopped = true;
    for (const lease of this.leases) this.cancel(lease);
    this.redis.disconnect();
    await Promise.allSettled(this.pending);
    this.leases.clear();
  }
}
