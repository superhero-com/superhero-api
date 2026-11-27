import { isAbsolute } from 'node:path';
import { publishingPolicy } from './shorts-publication-transaction';
import type { PublishingDeployment } from './shorts-publication-boundary.service';
import {
  ShortsRelease,
  ShortsArtifact,
  shortsConfigJson,
  loadShortsRelease,
  shortsArtifact,
} from './shorts-release';

export const publisherJson = shortsConfigJson;

export const SHORTS_PUBLISHER_CONFIG = Symbol('SHORTS_PUBLISHER_CONFIG');
export interface ShortsPublisherConfig extends PublishingDeployment {
  artifact: ShortsArtifact;
  release: ShortsRelease;
  nodeUrl: string;
  keyFile: string;
  pollMs: number;
}

export async function publishingDeployment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublishingDeployment> {
  const release = await loadShortsRelease(env);
  return deploymentForRelease(release, env);
}

async function deploymentForRelease(
  release: ShortsRelease,
  env: NodeJS.ProcessEnv,
): Promise<PublishingDeployment> {
  return {
    scope: { network: release.network, contract: release.contract },
    sourceHash: release.sourceHash,
    operator: release.operator,
    policy: publishingPolicy(
      await publisherJson(env.SHORTS_PUBLISHING_POLICY_FILE),
    ),
  };
}

export async function shortsPublisherConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShortsPublisherConfig> {
  if (
    env.ENABLE_SHORTS !== 'true' ||
    env.AE_NETWORK_ID !== 'ae_uat' ||
    env.SHORTS_TESTNET_MVP !== '1' ||
    env.SHORTS_DEMO_AUTO_APPROVE === '1' ||
    env.SHORTS_DEMO_CONNECTED_WALLET === '1'
  )
    throw new Error('Publisher requires reviewed testnet Shorts');
  if (
    Object.keys(env).some(
      (key) =>
        env[key] &&
        (/^SHORTS_(S3_|PRIVATE_|IPFS_|STREAM_)/.test(key) ||
          key === 'SHORTS_DATA_DIR' ||
          key === 'SHORTS_MODERATION_TOKEN_FILE' ||
          key.startsWith('AWS_')),
    )
  )
    throw new Error(
      'Do not provide media, storage or delivery credentials to the publisher',
    );
  const release = await loadShortsRelease(env);
  const deployment = await deploymentForRelease(release, env);
  const artifact = shortsArtifact(
    await publisherJson(env.SHORTS_CONTRACT_ARTIFACT),
    release,
  );
  if (!isAbsolute(env.SHORTS_OPERATOR_KEY_FILE || ''))
    throw new Error('Mount the dedicated publisher key');
  if (
    env.SHORTS_PUBLISHER_NODE_URL &&
    env.SHORTS_PUBLISHER_NODE_URL !== release.node
  )
    throw new Error(
      'Publisher node override does not match the release manifest',
    );
  const pollMs = Number(env.SHORTS_PUBLISHER_POLL_MS || 5000);
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60000)
    throw new Error('Invalid publisher poll interval');
  return {
    ...deployment,
    artifact,
    release,
    nodeUrl: release.node,
    keyFile: env.SHORTS_OPERATOR_KEY_FILE,
    pollMs,
  };
}
