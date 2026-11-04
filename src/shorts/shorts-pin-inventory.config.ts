import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { retentionConfig, RetentionConfig } from './shorts-retention.config';

export const SHORTS_PIN_INVENTORY_CONFIG = Symbol(
  'SHORTS_PIN_INVENTORY_CONFIG',
);
export interface PinInventoryConfig extends RetentionConfig {
  api: string;
  token: string;
  peerId: string;
  storageId: string;
}
export async function pinInventoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PinInventoryConfig> {
  const deployment = await retentionConfig(env);
  const api = new URL(env.SHORTS_PIN_API || '');
  const peerId = env.SHORTS_PIN_PEER_ID || '';
  if (
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    api.pathname !== '/api/v0' ||
    !/^[a-zA-Z0-9]{32,120}$/.test(peerId) ||
    !(
      api.protocol === 'https:' ||
      (api.protocol === 'http:' &&
        env.NODE_ENV !== 'production' &&
        env.SHORTS_PIN_ALLOW_LOOPBACK === '1' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname))
    )
  )
    throw new Error(
      'Pin inventory requires private HTTPS and an explicit node identity',
    );
  const path = env.SHORTS_PIN_TOKEN_FILE;
  if (!path || !isAbsolute(path))
    throw new Error('Use an absolute inventory token file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 128)
      throw new Error('Use an owner-only inventory token file');
    const data = Buffer.alloc(129),
      { bytesRead } = await file.read(data, 0, data.length, 0);
    token = data.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead > 128 || !/^[a-f0-9]{64}$/.test(token))
      throw new Error('Invalid inventory token');
  } finally {
    await file.close();
  }
  return {
    ...deployment,
    api: api.href,
    token,
    peerId,
    storageId: createHash('sha256')
      .update(JSON.stringify([api.href, peerId]))
      .digest('hex'),
  };
}
