import { isAbsolute } from 'node:path';
import { Encoding, isAddressValid } from '@aeternity/aepp-sdk';
import {
  loadShortsRelease,
  ShortsRelease,
  shortsArtifact,
  ShortsArtifact,
  shortsConfigJson,
} from './shorts-release';
import {
  LikeSponsorshipPolicy,
  likeSponsorshipPolicy,
} from './shorts-like-sponsorship-transaction';

export const SHORTS_LIKE_SPONSOR_CONFIG = Symbol('SHORTS_LIKE_SPONSOR_CONFIG');
export interface LikeSponsorConfig {
  enabled: boolean;
  recovery?: boolean;
  release?: ShortsRelease;
  artifact?: ShortsArtifact;
  payer?: string;
  policy?: LikeSponsorshipPolicy;
  databaseUrl?: string;
  keyFile?: string;
}

/** A separate least-privilege queue login; never add signing keys to the HTTP API. */
export async function likeSponsorConfig(
  worker = false,
  env: NodeJS.ProcessEnv = process.env,
  administrative = false,
): Promise<LikeSponsorConfig> {
  if (!worker && env.SHORTS_LIKE_SPONSOR_KEY_FILE)
    throw new Error('Like sponsor key belongs only in the isolated signer');
  const enabled = env.SHORTS_LIKE_SPONSOR_ENABLED === 'true';
  const recovery = env.SHORTS_LIKE_SPONSOR_RECOVERY === '1';
  if (administrative && (worker || enabled || recovery))
    throw new Error('Administrative sponsorship requires disabled admission');
  if (recovery && (!worker || enabled))
    throw new Error('Explicit signer recovery requires admission disabled');
  if (!enabled && !env.SHORTS_LIKE_SPONSOR_POLICY_FILE) {
    if (worker) throw new Error('Like sponsorship is disabled');
    return { enabled: false };
  }
  if (
    env.AE_NETWORK_ID !== 'ae_uat' ||
    env.SHORTS_TESTNET_MVP !== '1' ||
    env.SHORTS_DEMO_CONNECTED_WALLET === '1' ||
    env.SHORTS_DEMO_AUTO_APPROVE === '1'
  ) {
    throw new Error('Sponsorship requires authenticated testnet Shorts');
  }
  const release = await loadShortsRelease(env);
  const artifact = shortsArtifact(
    await shortsConfigJson(env.SHORTS_CONTRACT_ARTIFACT),
    release,
  );
  const config = await shortsConfigJson(env.SHORTS_LIKE_SPONSOR_POLICY_FILE);
  const policy = likeSponsorshipPolicy(config);
  if (
    release.network !== 'ae_uat' ||
    release.schemaVersion !== 2 ||
    !isAddressValid(config.payer, Encoding.AccountAddress) ||
    [release.operator, release.treasury].includes(config.payer)
  ) {
    throw new Error(
      'Use a dedicated fee payer with no Shorts operator or treasury authority',
    );
  }
  const databaseUrl = administrative
    ? undefined
    : env.SHORTS_LIKE_SPONSOR_DATABASE_URL;
  if (
    !administrative &&
    (!databaseUrl ||
      !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol))
  ) {
    throw new Error(
      'Dedicated sponsorship queue database credentials required',
    );
  }
  if (
    worker &&
    (!isAbsolute(env.SHORTS_LIKE_SPONSOR_KEY_FILE || '') ||
      env.SHORTS_OPERATOR_KEY_FILE ||
      Object.keys(env).some(
        (key) =>
          env[key] &&
          (/^SHORTS_(S3_|PRIVATE_|IPFS_|STREAM_)/.test(key) ||
            key.startsWith('AWS_')),
      ))
  ) {
    throw new Error(
      'Isolated Like sponsor needs only its dedicated fee key and queue credentials',
    );
  }
  return {
    enabled,
    recovery,
    release,
    artifact,
    payer: config.payer,
    policy,
    databaseUrl,
    keyFile: worker ? env.SHORTS_LIKE_SPONSOR_KEY_FILE : undefined,
  };
}
