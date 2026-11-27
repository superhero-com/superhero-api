import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Encoding, isAddressValid } from '@aeternity/aepp-sdk';

export const PROFILE_MEDIA_CONFIG = Symbol('PROFILE_MEDIA_CONFIG');
export type ImageRole = 'avatar' | 'cover';
export type MediaRole = ImageRole | 'post';
export interface ProfileMediaConfig {
  enabled: boolean;
  network: 'ae_mainnet' | 'ae_uat';
  contract: `ct_${string}`;
  storageContract?: `ct_${string}`;
  node: string;
  origin: string;
  publicUrl: string;
  ipfs: string;
  ipfsTokenFile: string;
  providerKeyFile: string;
  maxStoredBytes: number;
  scope: string;
}
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const imageRole = (value: unknown): value is ImageRole =>
  value === 'avatar' || value === 'cover';
export const mediaRole = (value: unknown): value is MediaRole =>
  imageRole(value) || value === 'post';
export const imageCid = (value: unknown): value is string =>
  typeof value === 'string' && /^bafy[a-z2-7]{55}$/.test(value);
export const imageAddress = (value: unknown): value is `ak_${string}` =>
  typeof value === 'string' && isAddressValid(value, Encoding.AccountAddress);

function endpoint(value: string, path?: string) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' &&
      !(
        local &&
        url.protocol === 'http:' &&
        process.env.NODE_ENV !== 'production'
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (path !== undefined && url.pathname !== path)
  )
    throw new Error('Invalid profile media endpoint');
  return url.href.replace(/\/$/, '');
}

export function profileMediaConfig(): ProfileMediaConfig {
  if (process.env.PROFILE_MEDIA_ENABLED !== 'true')
    return { enabled: false } as ProfileMediaConfig;
  const network = process.env.AE_NETWORK_ID || '';
  const contract = process.env.PROFILE_MEDIA_CONTRACT || '';
  const storageContract =
    process.env.PROFILE_MEDIA_STORAGE_CONTRACT || contract;
  if (
    !['ae_mainnet', 'ae_uat'].includes(network) ||
    !isAddressValid(contract, Encoding.ContractAddress) ||
    !isAddressValid(storageContract, Encoding.ContractAddress)
  )
    throw new Error(
      'Profile media requires an explicit network and AddressLink contract',
    );
  const providerKeyFile = process.env.PROFILE_MEDIA_PROVIDER_KEY_FILE || '';
  const ipfsTokenFile =
    process.env.PROFILE_MEDIA_IPFS_TOKEN_FILE ||
    process.env.SHORTS_IPFS_TOKEN_FILE ||
    '';
  if (![providerKeyFile, ipfsTokenFile].every(isAbsolute))
    throw new Error(
      'Profile media requires absolute backend credential file paths',
    );
  const maxStoredBytes = Number(
    process.env.PROFILE_MEDIA_MAX_STORED_BYTES || 268435456,
  );
  if (
    !Number.isSafeInteger(maxStoredBytes) ||
    maxStoredBytes < 1048576 ||
    maxStoredBytes > 1073741824
  )
    throw new Error('Invalid profile media storage budget');
  return {
    maxStoredBytes,
    enabled: true,
    network: network as ProfileMediaConfig['network'],
    contract: contract as `ct_${string}`,
    storageContract: storageContract as `ct_${string}`,
    node: endpoint(
      process.env.PROFILE_MEDIA_NODE ||
        (network === 'ae_uat'
          ? 'https://testnet.aeternity.io'
          : 'https://mainnet.aeternity.io'),
      '/',
    ),
    origin: endpoint(process.env.PROFILE_MEDIA_ORIGIN || '', '/'),
    publicUrl: endpoint(process.env.PROFILE_MEDIA_PUBLIC_URL || ''),
    ipfs: endpoint(
      process.env.PROFILE_MEDIA_IPFS_API || process.env.SHORTS_IPFS_API || '',
      '/api/v0',
    ),
    ipfsTokenFile,
    providerKeyFile,
    scope: `${network}:${contract}`,
  };
}

/** Never log the content or exceptions from credential parsing. */
export async function profileMediaSecret(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0)
      throw new Error('Invalid profile media credential permissions');
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) throw new Error('Invalid profile media credential');
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await file.close();
  }
}
