import * as Redis from 'ioredis';
import 'dotenv/config';

export const REDIS_CONFIG: Redis.RedisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
};
