import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import Redis from 'ioredis';
import { SHORTS_RATE_CONFIG, ShortsRateConfig } from './shorts-rate.config';
import { ShortsIndexService } from './shorts-index.service';

export const SHORTS_SOCKET_LIMITS = Symbol('SHORTS_SOCKET_LIMITS');
export const shortsSocketLimits = {
  clientConnections: 20,
  globalConnections: 1000,
  nodeConnections: 250,
  clientAttempts: 60,
  globalAttempts: 6000,
  leaseMs: 30000,
  renewMs: 10000,
};
export type ShortsSocketLimits = typeof shortsSocketLimits;
export interface SocketLease {
  id: string;
  global: string;
  client: string;
  deadline: number;
}

const acquire = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
local tokens = {}
for i=1,2 do
  local capacity = tonumber(ARGV[i])
  local state = redis.call('HMGET',KEYS[i],'tokens','at')
  local available = capacity
  if state[1] then
    local previous = tonumber(state[1])
    local at = tonumber(state[2])
    if not previous or not at or previous < 0 then return redis.error_reply('Invalid rate state') end
    available = math.min(capacity,previous + math.max(0,now-at)*capacity/60000)
  end
  if available < 1 then return 0 end
  tokens[i] = available-1
end
for i=1,2 do
  redis.call('HSET',KEYS[i],'tokens',tokens[i],'at',now)
  redis.call('PEXPIRE',KEYS[i],60000)
end
redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',now)
redis.call('ZREMRANGEBYSCORE',KEYS[4],'-inf',now)
if redis.call('ZCARD',KEYS[3]) >= tonumber(ARGV[3]) or redis.call('ZCARD',KEYS[4]) >= tonumber(ARGV[4]) then return 0 end
local ttl = tonumber(ARGV[5])
redis.call('ZADD',KEYS[3],now+ttl,ARGV[6])
redis.call('ZADD',KEYS[4],now+ttl,ARGV[6])
redis.call('PEXPIRE',KEYS[3],ttl*2)
redis.call('PEXPIRE',KEYS[4],ttl*2)
return 1
`;
const renew = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
local ttl = tonumber(ARGV[1])
local alive = {}
for i=2,#KEYS do
  local id = ARGV[i]
  local global = tonumber(redis.call('ZSCORE',KEYS[1],id) or '0')
  local client = tonumber(redis.call('ZSCORE',KEYS[i],id) or '0')
  if global > now and client > now then
    redis.call('ZADD',KEYS[1],now+ttl,id)
    redis.call('ZADD',KEYS[i],now+ttl,id)
    redis.call('PEXPIRE',KEYS[i],ttl*2)
    table.insert(alive,id)
  end
end
redis.call('PEXPIRE',KEYS[1],ttl*2)
return alive
`;

@Injectable()
export class ShortsSocketService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly redis: Redis;
  private readonly pending = new Set<Promise<unknown>>();
  private unavailable = true;
  private stopped = false;
  constructor(
    @Inject(SHORTS_RATE_CONFIG) private readonly config: ShortsRateConfig,
    private readonly index: ShortsIndexService,
    @Inject(SHORTS_SOCKET_LIMITS) readonly limits: ShortsSocketLimits,
  ) {
    this.redis = new Redis({
      ...config.redis,
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
      throw new Error('Shorts live-update admission unavailable');
    }
  }
  healthy() {
    return !this.stopped && !this.unavailable && this.redis.status === 'ready';
  }
  private async execute<T>(operation: () => Promise<T>) {
    if (!this.healthy() || this.pending.size >= 32)
      throw new Error('Shorts live updates unavailable');
    const task = operation();
    this.pending.add(task);
    try {
      return await task;
    } catch {
      if (!this.stopped && !this.unavailable) {
        this.unavailable = true;
        this.redis.disconnect(true);
      }
      throw new Error('Shorts live updates unavailable');
    } finally {
      this.pending.delete(task);
    }
  }
  async acquire(request: IncomingMessage): Promise<SocketLease | undefined> {
    const identity = this.index.identity();
    if (
      !['ae_uat', 'ae_mainnet'].includes(identity.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(identity.contract)
    )
      throw new Error('Shorts deployment unavailable');
    const scope = createHash('sha256')
      .update(`${identity.network}:${identity.contract}`)
      .digest('hex')
      .slice(0, 32);
    const prefix = `shorts:ws:v1:{${scope}}`;
    const ip = createHmac('sha256', this.config.key)
      .update(this.config.client(request as Request))
      .digest('hex');
    const lease: SocketLease = {
      id: randomUUID(),
      global: `${prefix}:connections`,
      client: `${prefix}:client:${ip}`,
      deadline: performance.now() + this.limits.leaseMs - 2000,
    };
    const result = await this.execute(() =>
      this.redis.eval(
        acquire,
        4,
        `${prefix}:attempts:global`,
        `${prefix}:attempts:${ip}`,
        lease.global,
        lease.client,
        this.limits.globalAttempts,
        this.limits.clientAttempts,
        this.limits.globalConnections,
        this.limits.clientConnections,
        this.limits.leaseMs,
        lease.id,
      ),
    );
    if (result !== 0 && result !== 1)
      throw new Error('Invalid admission result');
    return result === 1 ? lease : undefined;
  }
  async renew(leases: SocketLease[]) {
    if (!leases.length) return new Set<string>();
    if (
      leases.length > 64 ||
      leases.some((lease) => lease.global !== leases[0].global)
    )
      throw new Error('Invalid lease batch');
    const deadline = performance.now() + this.limits.leaseMs - 2000;
    const result = await this.execute(() =>
      this.redis.eval(
        renew,
        1 + leases.length,
        leases[0].global,
        ...leases.map((lease) => lease.client),
        this.limits.leaseMs,
        ...leases.map((lease) => lease.id),
      ),
    );
    if (!Array.isArray(result) || result.some((id) => typeof id !== 'string'))
      throw new Error('Invalid lease result');
    const active = new Set<string>(result);
    leases.forEach((lease) => {
      if (active.has(lease.id)) lease.deadline = deadline;
    });
    return active;
  }
  async release(lease: SocketLease) {
    await this.execute(() =>
      this.redis.eval(
        "redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1",
        2,
        lease.global,
        lease.client,
        lease.id,
      ),
    );
  }
  async beforeApplicationShutdown() {
    this.stopped = true;
    this.redis.disconnect();
    await Promise.allSettled(this.pending);
  }
}
