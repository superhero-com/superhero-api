import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { retentionConfig, RetentionConfig } from './shorts-retention.config';

export const SHORTS_HLS_INVENTORY_CONFIG = Symbol(
  'SHORTS_HLS_INVENTORY_CONFIG',
);
export interface HlsInventoryConfig extends RetentionConfig {
  redisUrl: string;
  password: string;
  namespace: string;
  storageId: string;
}
export async function hlsInventoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HlsInventoryConfig> {
  const deployment = await retentionConfig(env);
  const url = new URL(env.SHORTS_HLS_REDIS_URL || '');
  const namespace = env.SHORTS_HLS_NAMESPACE || '';
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    !url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(0|[1-9][0-9]?)$/.test(url.pathname) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(namespace) ||
    (url.protocol === 'redis:' &&
      !(
        env.NODE_ENV !== 'production' &&
        env.SHORTS_HLS_ALLOW_LOOPBACK === '1' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error(
      'HLS inventory requires explicit authenticated Redis TLS; plaintext loopback tests must opt in',
    );
  const path = env.SHORTS_HLS_REDIS_PASSWORD_FILE;
  if (!path || !isAbsolute(path))
    throw new Error('Use an absolute Redis password file');
  const file = await open(path, 'r');
  let password: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077)
      throw new Error('Use an owner-only Redis password file');
    const buffer = Buffer.alloc(4097),
      { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error('Invalid Redis credential size');
    password = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!password || password.includes('\0'))
      throw new Error('Invalid Redis credential');
  } finally {
    await file.close();
  }
  return {
    ...deployment,
    redisUrl: url.href,
    password,
    namespace,
    storageId: createHash('sha256')
      .update(JSON.stringify([url.protocol, url.host, url.pathname, namespace]))
      .digest('hex'),
  };
}
