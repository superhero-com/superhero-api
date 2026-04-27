import * as Redis from 'ioredis';
import 'dotenv/config';

// `REDIS_PASSWORD` is optional so dev/testnet stacks without auth keep
// working, but when set it must be used both by the Redis server
// (`requirepass`) and by the API (here).
export const REDIS_CONFIG: Redis.RedisOptions = {
  keyPrefix: process.env.AE_NETWORK_ID || 'ae_mainnet',
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};
