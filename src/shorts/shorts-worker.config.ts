import { loadShortsRelease, ShortsRelease } from './shorts-release';
import {
  shortsScratchConfig,
  ShortsScratchConfig,
} from './shorts-scratch.config';
import type { ShortsScope } from './shorts-metadata.service';

export const SHORTS_WORKER_CONFIG = Symbol('SHORTS_WORKER_CONFIG');
export interface ShortsWorkerConfig {
  release: ShortsRelease;
  scope: ShortsScope;
  sourceHash: string;
  leaseMs: number;
  scratch: ShortsScratchConfig;
}

export async function shortsWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShortsWorkerConfig> {
  if (
    env.ENABLE_SHORTS !== 'true' ||
    env.AE_NETWORK_ID !== 'ae_uat' ||
    env.SHORTS_TESTNET_MVP !== '1' ||
    env.SHORTS_DEMO_AUTO_APPROVE === '1' ||
    env.SHORTS_DEMO_CONNECTED_WALLET === '1'
  )
    throw new Error(
      'The shared media worker requires enabled, reviewed testnet Shorts',
    );
  if (
    [
      'SHORTS_OPERATOR_KEY_FILE',
      'SHORTS_IPFS_TOKEN_FILE',
      'SHORTS_STREAM_KEY_FILE',
    ].some((key) => !!env[key])
  )
    throw new Error(
      'Do not provide signing, IPFS publishing or streaming credentials to the media worker',
    );
  const deployment = await loadShortsRelease(env);
  const leaseMs = Number(env.SHORTS_WORKER_LEASE_MS || 120000);
  const scratch = shortsScratchConfig(env);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000)
    throw new Error('Invalid media worker deployment or lease');
  return {
    release: deployment,
    scope: {
      network: deployment.network,
      contract: deployment.storage?.contract ?? deployment.contract,
    },
    sourceHash: deployment.storage?.sourceHash ?? deployment.sourceHash,
    leaseMs,
    scratch,
  };
}
