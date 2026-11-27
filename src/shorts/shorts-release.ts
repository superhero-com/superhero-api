import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { Encoding, isAddressValid } from '@aeternity/aepp-sdk';
import {
  ShortsContractPolicy,
  shortsContractPolicy,
} from './shorts-contract-policy';

/** Public release identity, mounted independently of the compiled artifact. */
export interface ShortsArtifactIdentity {
  compiler: string;
  sourceHash: string;
  bytecodeHash: string;
  aciHash: string;
}
export interface ShortsRelease {
  schemaVersion: 2;
  network: 'ae_uat' | 'ae_mainnet';
  node: string;
  middleware: string;
  contract: `ct_${string}`;
  previousContract: null;
  operator: `ak_${string}`;
  treasury: `ak_${string}`;
  compiler: string;
  sourceHash: string;
  bytecodeHash: string;
  aciHash: string;
  likeFeeAetto: string;
  treasuryBps: number;
}

export interface ShortsArtifact {
  compiler: string;
  sourceHash: string;
  bytecodeHash: string;
  bytecode: string;
  aci: any[];
}

export const releaseHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Bounded, no-symlink reads. Secret material has stricter ownership/mode checks. */
export async function shortsConfigJson(path: string, secret = false) {
  if (!isAbsolute(path || ''))
    throw new Error('An absolute configuration path is required');
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const limit = secret ? 4096 : 1048576;
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > limit ||
      (secret && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error('Invalid configuration file permissions or size');
    // Read one byte past the bound, including if the file grows after stat().
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > limit) throw new Error('Configuration file is too large');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

function endpoint(value: unknown, node: boolean, allowLoopback: boolean) {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('Invalid release endpoint');
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(
        allowLoopback &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (node ? value !== url.origin : value !== url.href.replace(/\/$/, ''))
  )
    throw new Error('Release endpoints must be canonical HTTPS URLs');
  return value;
}

export function shortsRelease(
  value: unknown,
  allowLoopback = false,
): ShortsRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Shorts release manifest');
  const v = value as Record<string, any>;
  if (
    v.schemaVersion !== 2 ||
    !['ae_uat', 'ae_mainnet'].includes(v.network) ||
    !isAddressValid(v.contract, Encoding.ContractAddress) ||
    !isAddressValid(v.operator, Encoding.AccountAddress) ||
    !isAddressValid(v.treasury, Encoding.AccountAddress) ||
    v.previousContract != null ||
    v.previousArtifact !== undefined ||
    v.storage !== undefined ||
    (v.rewardContracts !== undefined &&
      !(Array.isArray(v.rewardContracts) && v.rewardContracts.length === 0)) ||
    typeof v.compiler !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(v.compiler) ||
    !['sourceHash', 'bytecodeHash', 'aciHash'].every(
      (key) => typeof v[key] === 'string' && /^[a-f0-9]{64}$/.test(v[key]),
    ) ||
    typeof v.likeFeeAetto !== 'string' ||
    !/^(0|[1-9]\d{0,77})$/.test(v.likeFeeAetto) ||
    BigInt(v.likeFeeAetto) >= 2n ** 256n ||
    !Number.isInteger(v.treasuryBps) ||
    v.treasuryBps < 0 ||
    v.treasuryBps > 10000
  )
    throw new Error('Invalid Shorts release manifest');
  // Copy only reviewed identity fields; deployment receipts may have extra metadata.
  return Object.freeze({
    schemaVersion: v.schemaVersion,
    network: v.network,
    node: endpoint(v.node, true, allowLoopback),
    middleware: endpoint(v.middleware, false, allowLoopback),
    contract: v.contract,
    previousContract: null,
    operator: v.operator,
    treasury: v.treasury,
    compiler: v.compiler,
    sourceHash: v.sourceHash,
    bytecodeHash: v.bytecodeHash,
    aciHash: v.aciHash,
    likeFeeAetto: v.likeFeeAetto,
    treasuryBps: v.treasuryBps,
  });
}

/** Limit the runtime to its configured indexer network. */
export function assertSupportedShortsRelease(
  release: ShortsRelease,
  env = process.env,
) {
  if (
    release.network !== 'ae_uat' ||
    (env.AE_NETWORK_ID && env.AE_NETWORK_ID !== release.network)
  )
    throw new Error('Shorts release network is not supported by this runtime');
  // Keep this loader free of application config imports, which load ambient .env
  // files. The dedicated publisher must use only its explicit environment.
  if (release.middleware !== 'https://testnet.aeternity.io/mdw')
    throw new Error('Shorts release middleware does not match the indexer');
}

/** All service roles consume the same reviewed manifest; no ambient config imports. */
export async function loadShortsRelease(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShortsRelease> {
  const release = shortsRelease(
    await shortsConfigJson(env.SHORTS_DEPLOYMENT_FILE),
    env.NODE_ENV !== 'production',
  );
  assertSupportedShortsRelease(release, env);
  return release;
}

export function shortsArtifact(
  value: unknown,
  release: ShortsArtifactIdentity,
): ShortsArtifact {
  const a = value as ShortsArtifact | undefined;
  if (
    !a ||
    a.compiler !== release.compiler ||
    a.sourceHash !== release.sourceHash ||
    a.bytecodeHash !== release.bytecodeHash ||
    typeof a.bytecode !== 'string' ||
    !a.bytecode.startsWith('cb_') ||
    releaseHash(a.bytecode) !== release.bytecodeHash ||
    !Array.isArray(a.aci) ||
    !a.aci.length ||
    releaseHash(JSON.stringify(a.aci)) !== release.aciHash
  )
    throw new Error('Shorts artifact does not match the release manifest');
  return a;
}

/** A zero price alone cannot advertise the new nonpayable Like entrypoint. */
export function shortsLikeMode(
  release: ShortsRelease,
  artifact: ShortsArtifact,
  policy: ShortsContractPolicy,
): 'free' | 'paid' {
  const bound = shortsArtifact(artifact, release);
  const contracts = bound.aci
    .map((item) => item.contract)
    .filter((item) => item?.kind === 'contract_main');
  const functions =
    contracts.length === 1 && Array.isArray(contracts[0].functions)
      ? contracts[0].functions
      : [];
  const likes = functions.filter((fn: any) => fn.name === 'like');
  if (!likes.length && policy.likeFeeAetto !== '0') return 'paid';
  const like = likes[0];
  if (
    release.schemaVersion !== 2 ||
    release.likeFeeAetto !== '0' ||
    policy.likeFeeAetto !== '0' ||
    likes.length !== 1 ||
    like.payable !== false ||
    like.stateful !== true ||
    JSON.stringify(like.arguments?.map((arg: any) => arg.type)) !==
      JSON.stringify(['string', 'int']) ||
    functions.some((fn: any) => fn.name === 'paid_like')
  )
    throw new Error('Shorts Like capability does not match its release');
  return 'free';
}

export function assertShortsReleaseConfig(
  release: ShortsRelease,
  cfg: unknown,
) {
  shortsContractPolicy(cfg, release.schemaVersion);
}

/** The contract exposes its deployment mode and lifecycle in this getter. */
export function assertActiveShortsContract(status: Record<string, unknown>) {
  if (
    status?.schema !== 2n ||
    status.importing !== false ||
    status.import_started !== false ||
    status.abandoned !== false ||
    status.frozen !== false ||
    status.reserved_source != null
  )
    throw new Error('Expected a fresh, active Shorts contract');
}
