import {
  privateObjectConfig,
  PrivateObjectConfig,
} from './shorts-private-objects.service';
import {
  storageInventoryConfig,
  StorageInventoryConfig,
} from './shorts-storage-inventory.config';

export const SHORTS_STORAGE_RECONCILIATION_CONFIG = Symbol(
  'SHORTS_STORAGE_RECONCILIATION_CONFIG',
);
export interface StorageReconciliationConfig extends StorageInventoryConfig {
  objects: PrivateObjectConfig;
}
export async function storageReconciliationConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StorageReconciliationConfig> {
  const inventory = await storageInventoryConfig({
    ...env,
    SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE: undefined,
  });
  const objects = await privateObjectConfig(env);
  return { ...inventory, objects };
}
