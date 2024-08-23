import * as Redis from 'ioredis';
import 'dotenv/config';

export const REDIS_CONFIG: Redis.RedisOptions = {
  keyPrefix: process.env.AE_NETWORK_ID || 'ae_mainnet',
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
};
