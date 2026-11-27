import { shortsRuntimeScope } from './shorts-runtime-scope';
import {
  HttpException,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import Redis from 'ioredis';
import { ShortsChainService } from './shorts-chain.service';
import { SHORTS_RATE_CONFIG, ShortsRateConfig } from './shorts-rate.config';
import {
  SHORTS_RATE_BYTES,
  SHORTS_RATE_GROUPS,
  ShortsHttpPolicy,
} from './shorts-rate-policy';

interface Bucket {
  key: string;
  capacity: number;
  period: number;
  cost: number;
}

// One Redis-clock token-bucket decision across all supplied budgets. Denials do
// not create per-client keys or partially debit another bucket. Every accepted
// bucket expires once it could be fully refilled. No scanning or client clock.
const consume = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
local values = {}
local retry = 0
for i,key in ipairs(KEYS) do
  local offset = (i-1)*3
  local capacity = tonumber(ARGV[offset+1])
  local period = tonumber(ARGV[offset+2])
  local cost = tonumber(ARGV[offset+3])
  local state = redis.call('HMGET',key,'tokens','at')
  local tokens = capacity
  if state[1] then
    local previous = tonumber(state[1])
    local at = tonumber(state[2])
    if not previous or not at or previous < 0 or previous > capacity then
      return redis.error_reply('Invalid rate state')
    end
    tokens = math.min(capacity,previous + math.max(0,now-at)*capacity/period)
  end
  values[i] = tokens-cost
  if tokens < cost then retry = math.max(retry,math.ceil((cost-tokens)*period/capacity)) end
end
if retry > 0 then return {0,retry} end
for i,key in ipairs(KEYS) do
  redis.call('HSET',key,'tokens',values[i],'at',now)
  redis.call('PEXPIRE',key,ARGV[(i-1)*3+2])
end
return {1,0}
`;

@Injectable()
export class ShortsRateService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly redis: Redis;
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;
  private unavailable = true;
  constructor(
    @Inject(SHORTS_RATE_CONFIG) readonly config: ShortsRateConfig,
    private readonly chain: ShortsChainService,
  ) {
    this.redis = new Redis({
      ...config.redis,
      keyPrefix: '',
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      commandTimeout: 1000,
      connectTimeout: 1000,
      retryStrategy: (attempt) => Math.min(1000 * attempt, 5000),
    });
    // Request errors are reported as opaque 503s; never log connection secrets
    // or per-client identifiers. Redis health must be monitored independently.
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
      throw new Error('Shared Shorts request limits are unavailable');
    }
  }
  private prefix() {
    const { contract, network } = shortsRuntimeScope(this.chain);
    const { sourceHash } = this.chain.state;
    if (
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(contract || '') ||
      !/^[a-f0-9]{64}$/.test(sourceHash || '') ||
      process.env.AE_NETWORK_ID !== network
    )
      throw new ServiceUnavailableException(
        'Shorts request limits are not initialized',
      );
    const scope = createHash('sha256')
      .update(`${network}:${contract}`)
      .digest('hex')
      .slice(0, 32);
    return `shorts:rate:v1:{${scope}}`;
  }
  private identity(type: string, value: string) {
    if (!value || value.length > 128) throw new Error('Invalid rate identity');
    return createHmac('sha256', this.config.key)
      .update(`${type}:${value}`)
      .digest('hex');
  }
  async request(policy: ShortsHttpPolicy, ip: string) {
    const [capacity, period, global] = SHORTS_RATE_GROUPS[policy.group];
    const key = this.identity('ip', ip),
      prefix = this.prefix();
    await this.take([
      { key: `${prefix}:ip:${key}:${policy.group}`, capacity, period, cost: 1 },
      {
        // Anonymous attempts must not consume an authenticated operation's
        // budget. Still bound aggregate authentication work and key creation.
        key: `${prefix}:global:${policy.private ? 'privateAdmission' : policy.group}`,
        capacity: policy.private ? 3000 : global,
        period: policy.private ? 60000 : period,
        cost: 1,
      },
    ]);
  }
  async actor(policy: ShortsHttpPolicy, ip: string, actor: string) {
    const [ipLimit, period, global, walletLimit] =
      SHORTS_RATE_GROUPS[policy.group];
    const prefix = this.prefix(),
      owner = this.identity('actor', actor);
    const buckets: Bucket[] = [
      {
        key: `${prefix}:global:${policy.group}`,
        capacity: global,
        period,
        cost: 1,
      },
      {
        key: `${prefix}:actor:${owner}:${policy.group}`,
        capacity: walletLimit || ipLimit,
        period,
        cost: 1,
      },
    ];
    if (policy.bytes) {
      const budgets = SHORTS_RATE_BYTES;
      for (const [key, capacity] of [
        [`ip:${this.identity('ip', ip)}`, budgets.ip],
        [`actor:${owner}`, budgets.actor],
        ['global', budgets.global],
      ] as const)
        buckets.push({
          key: `${prefix}:bytes:${key}`,
          capacity,
          period: budgets.period,
          cost: policy.bytes,
        });
    }
    await this.take(buckets);
  }
  private async take(buckets: Bucket[]) {
    if (
      this.stopped ||
      this.unavailable ||
      this.redis.status !== 'ready' ||
      this.pending.size >= 32
    )
      throw new ServiceUnavailableException(
        'Shorts is busy. Please try again shortly.',
      );
    const operation = this.redis.eval(
      consume,
      buckets.length,
      ...buckets.map((bucket) => bucket.key),
      ...buckets.flatMap((bucket) => [
        bucket.capacity,
        bucket.period,
        bucket.cost,
      ]),
    );
    this.pending.add(operation);
    try {
      const result = await operation;
      if (
        !Array.isArray(result) ||
        result.length !== 2 ||
        ![0, 1].includes(Number(result[0])) ||
        !Number.isSafeInteger(result[1]) ||
        result[1] < 0
      )
        throw new Error('Invalid rate decision');
      if (Number(result[0]) === 0)
        throw new HttpException(
          {
            message: 'Too many requests. Please try again shortly.',
            retryAfter: Math.max(1, Math.ceil(result[1] / 1000)),
          },
          429,
        );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // A timed-out Redis command can still occupy ioredis's wire queue.
      // Drop that socket before admitting more work; never resend its debit.
      if (!this.stopped && !this.unavailable) {
        this.unavailable = true;
        this.redis.disconnect(true);
      }
      throw new ServiceUnavailableException(
        'Shorts request limits are temporarily unavailable.',
      );
    } finally {
      this.pending.delete(operation);
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.redis.disconnect();
    await Promise.allSettled(this.pending);
  }
}
