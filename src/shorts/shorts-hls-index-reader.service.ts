import {
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import {
  HlsInventoryConfig,
  SHORTS_HLS_INVENTORY_CONFIG,
} from './shorts-hls-inventory.config';
import { hlsObservation } from './shorts-hls-inventory-data';

// COUNT is a hint, not a bound. Enforce key/value/page bounds inside Redis before replying.
const scan = `
local page=redis.call('SCAN',ARGV[1],'MATCH',ARGV[2]..'*','COUNT',10)
if #page[2]>64 then return redis.error_reply('HLS_PAGE_LIMIT') end
local epoch=string.match(redis.call('INFO','server'),'run_id:([0-9a-f]+)')
if not epoch or #epoch~=40 then return redis.error_reply('HLS_REDIS_IDENTITY') end
local result={epoch,page[1]}
local bytes=0
for _,key in ipairs(page[2]) do
  if #key~=#ARGV[2]+64 then return redis.error_reply('HLS_INDEX_KEY') end
  local length=redis.call('STRLEN',key)
  if length<1 or length>32768 or redis.call('PTTL',key)~=-1 then return redis.error_reply('HLS_INDEX_SIZE_OR_TTL') end
  bytes=bytes+length
  if bytes>262144 then return redis.error_reply('HLS_PAGE_LIMIT') end
  table.insert(result,{string.sub(key,#ARGV[2]+1),redis.call('GET',key)})
end
return result
`;

@Injectable()
export class ShortsHlsIndexReaderService implements OnModuleDestroy {
  private readonly client: Redis;
  private stopped = false;
  private busy = false;
  constructor(
    @Inject(SHORTS_HLS_INVENTORY_CONFIG)
    private readonly config: HlsInventoryConfig,
  ) {
    const url = new URL(config.redisUrl);
    this.client = new Redis({
      host: url.hostname,
      port: Number(url.port || 6379),
      db: Number(url.pathname.slice(1)),
      username: decodeURIComponent(url.username),
      password: config.password,
      tls: url.protocol === 'rediss:' ? {} : undefined,
      lazyConnect: true,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      retryStrategy: () => null,
      connectTimeout: 1000,
      commandTimeout: 2000,
    });
    this.client.on('error', () => {});
  }
  async page(cursor: string, signal?: AbortSignal) {
    if (
      typeof cursor !== 'string' ||
      !/^(0|[1-9][0-9]{0,19})$/.test(cursor) ||
      BigInt(cursor) > 18446744073709551615n
    )
      throw new Error('Invalid HLS inventory cursor');
    if (this.stopped || this.busy)
      throw new ServiceUnavailableException('HLS index inventory unavailable');
    const abort = AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(signal ? [signal] : []),
    ]);
    abort.throwIfAborted();
    this.busy = true;
    const cancel = () => this.onModuleDestroy();
    abort.addEventListener('abort', cancel, { once: true });
    try {
      if (this.client.status === 'wait') await this.client.connect();
      abort.throwIfAborted();
      const result = (await this.client.call(
        'EVAL_RO',
        scan,
        0,
        cursor,
        `${this.config.namespace}:prepared:`,
      )) as [string, string, ...[string, string][]];
      abort.throwIfAborted();
      if (
        !Array.isArray(result) ||
        result.length < 2 ||
        result.length > 66 ||
        typeof result[0] !== 'string' ||
        !/^[a-f0-9]{40}$/.test(result[0]) ||
        typeof result[1] !== 'string' ||
        !/^(0|[1-9][0-9]{0,19})$/.test(result[1]) ||
        BigInt(result[1]) > 18446744073709551615n
      )
        throw new Error('Invalid HLS scan response');
      return {
        epoch: result[0],
        next: result[1],
        items: result.slice(2).map((row) => {
          if (!Array.isArray(row) || row.length !== 2)
            throw new Error('Invalid HLS scan row');
          return hlsObservation(row[0], row[1]);
        }),
      };
    } catch {
      this.onModuleDestroy();
      throw new ServiceUnavailableException('HLS index inventory unavailable');
    } finally {
      abort.removeEventListener('abort', cancel);
      this.busy = false;
    }
  }
  onModuleDestroy() {
    this.stopped = true;
    this.client.disconnect();
  }
}
