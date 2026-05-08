import * as Redis from 'ioredis';
import 'dotenv/config';

// `REDIS_PASSWORD` is optional and intended for custom deployments that use
// an authenticated external Redis. The bundled compose Redis is localhost-only
// and does not enable `requirepass`.
export const REDIS_CONFIG: Redis.RedisOptions = {
  keyPrefix: process.env.AE_NETWORK_ID || 'ae_mainnet',
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};
