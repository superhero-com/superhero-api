import { createHash } from 'node:crypto';
import {
  privateBucketConfig,
  PrivateBucketConfig,
} from './shorts-private-objects.service';
import { retentionConfig, RetentionConfig } from './shorts-retention.config';

export const SHORTS_STORAGE_INVENTORY_CONFIG = Symbol(
  'SHORTS_STORAGE_INVENTORY_CONFIG',
);
export interface StorageInventoryConfig extends RetentionConfig {
  storage: PrivateBucketConfig;
  storageId: string;
  objectPrefix: string;
}
export async function storageInventoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StorageInventoryConfig> {
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value &&
        (/^SHORTS_(OPERATOR_|IPFS_|STREAM_|MODERATION_|PRIVATE_ENCRYPTION_)/.test(
          key,
        ) ||
          key.startsWith('AWS_')),
    )
  )
    throw new Error(
      'Storage inventory requires a separate environment without media or signing credentials',
    );
  const deployment = await retentionConfig({
    NODE_ENV: env.NODE_ENV,
    ENABLE_SHORTS: env.ENABLE_SHORTS,
    AE_NETWORK_ID: env.AE_NETWORK_ID,
    SHORTS_DEPLOYMENT_FILE: env.SHORTS_DEPLOYMENT_FILE,
    SHORTS_PRIVATE_S3_PREFIX: env.SHORTS_PRIVATE_S3_PREFIX,
  });
  const storage = await privateBucketConfig(env);
  const hash = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    ...deployment,
    storage,
    objectPrefix: `${storage.prefix}/${hash([deployment.scope.network, deployment.scope.contract])}/`,
    storageId: hash([
      storage.endpoint,
      storage.region,
      storage.bucket,
      storage.prefix,
      storage.forcePathStyle,
    ]),
  };
}
