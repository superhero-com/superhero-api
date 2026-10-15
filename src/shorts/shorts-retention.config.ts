import type { ShortsScope } from './shorts-metadata.service';
import { loadShortsRelease } from './shorts-release';

export const SHORTS_RETENTION_CONFIG = Symbol('SHORTS_RETENTION_CONFIG');
export interface RetentionConfig {
  scope: ShortsScope;
  sourceHash: string;
  prefix: string;
}
export async function retentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RetentionConfig> {
  if (env.ENABLE_SHORTS !== 'true' || env.AE_NETWORK_ID !== 'ae_uat')
    throw new Error('Retention tooling requires enabled testnet Shorts');
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value &&
        key !== 'SHORTS_PRIVATE_S3_PREFIX' &&
        (/^SHORTS_(PRIVATE_|S3_|IPFS_|STREAM_)/.test(key) ||
          key.startsWith('AWS_') ||
          ['SHORTS_OPERATOR_KEY_FILE', 'SHORTS_MODERATION_TOKEN_FILE'].includes(
            key,
          )),
    )
  )
    throw new Error(
      'Do not provide storage, media or signing credentials to reference inventory',
    );
  const manifest = await loadShortsRelease(env);
  const prefix = env.SHORTS_PRIVATE_S3_PREFIX || 'shorts-private-v1';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(prefix))
    throw new Error('Invalid retention deployment or private object prefix');
  return {
    scope: { network: manifest.network, contract: manifest.contract },
    sourceHash: manifest.sourceHash,
    prefix,
  };
}
