import { ServiceUnavailableException } from '@nestjs/common';
import type { ShortsRelease } from './shorts-release';
import type { ShortsScope } from './shorts-metadata.service';

type Runtime = {
  release?: Pick<ShortsRelease, 'network' | 'contract'>;
  state?: { contract?: string };
};
const bindings = new WeakMap<
  Runtime,
  {
    release: Runtime['release'];
    scope: Readonly<ShortsScope>;
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
        previous.scope.contract !== release.contract))
  )
    throw new ServiceUnavailableException(
      'Shorts deployment identity is unavailable',
    );
  if (previous) return previous.scope;
  const scope = Object.freeze({
    network: release.network,
    contract: release.contract,
  });
  bindings.set(chain, { release, scope });
  return scope;
}
