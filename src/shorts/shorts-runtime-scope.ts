import { ServiceUnavailableException } from '@nestjs/common';
import type { ShortsRelease } from './shorts-release';
import type { ShortsScope } from './shorts-metadata.service';

type Runtime = {
  release?: Pick<ShortsRelease, 'network' | 'contract' | 'storage'>;
  state?: { contract?: string; sourceHash?: string };
};
const bindings = new WeakMap<
  Runtime,
  {
    release: Runtime['release'];
    scope: Readonly<ShortsScope>;
    storage: string;
    storageScope: Readonly<ShortsScope>;
    storageHash?: string;
  }
>();

/** The release loader verifies artifacts; data adapters share its immutable identity.
 * Changing deployment requires a new process, never relabelling in-flight work.
 */
export function shortsRuntimeScope(chain: Runtime): Readonly<ShortsScope> {
  const release = chain?.release;
  const previous = bindings.get(chain);
  if (
    !release ||
    !['ae_uat', 'ae_mainnet'].includes(release.network) ||
    typeof release.contract !== 'string' ||
    !/^ct_[a-zA-Z0-9]{1,97}$/.test(release.contract) ||
    release.contract !== chain.state?.contract ||
    (previous &&
      (previous.release !== release ||
        previous.scope.network !== release.network ||
        previous.scope.contract !== release.contract ||
        previous.storage !== JSON.stringify(release.storage ?? null)))
  )
    throw new ServiceUnavailableException(
      'Shorts deployment identity is unavailable',
    );
  if (previous) return previous.scope;
  const scope = Object.freeze({
    network: release.network,
    contract: release.contract,
  });
  bindings.set(chain, {
    release,
    scope,
    storage: JSON.stringify(release.storage ?? null),
    storageScope: release.storage
      ? Object.freeze({
          network: release.network,
          contract: release.storage.contract,
        })
      : scope,
    storageHash: release.storage?.sourceHash,
  });
  return scope;
}

/** Media keys, encryption and content records retain their original namespace. */
export function shortsStorageScope(chain: Runtime): Readonly<ShortsScope> {
  shortsRuntimeScope(chain);
  return bindings.get(chain).storageScope;
}

export function shortsStorageSourceHash(chain: Runtime): string {
  shortsRuntimeScope(chain);
  return bindings.get(chain).storageHash ?? chain.state.sourceHash;
}
