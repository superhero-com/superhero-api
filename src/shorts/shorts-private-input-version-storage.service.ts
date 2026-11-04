import { Injectable } from '@nestjs/common';
import type { ShortsScope } from './shorts-metadata.service';
import {
  PrivateObjectRef,
  ShortsPrivateObjectsService,
} from './shorts-private-objects.service';
import { ShortsPrivateVersionStorageService } from './shorts-private-version-storage.service';

export interface PrivateVersionDispatch {
  scope: ShortsScope;
  ref: PrivateObjectRef;
  version: string;
  issuedAt: Date;
  expiresAt?: Date;
  assertCurrent: () => Promise<void>;
}
export type PrivateVersionIssuer = (
  scope: ShortsScope,
  ref: PrivateObjectRef,
  version: string,
) => Promise<PrivateVersionDispatch>;

/** Authenticated version I/O. The caller must supply fresh, journaled durability authority. */
@Injectable()
export class ShortsPrivateInputVersionStorageService {
  constructor(
    private readonly objects: ShortsPrivateObjectsService,
    private readonly storage: ShortsPrivateVersionStorageService,
  ) {}

  async remove(
    scope: ShortsScope,
    ref: PrivateObjectRef,
    version: string,
    signal: AbortSignal,
    issue: PrivateVersionIssuer,
  ) {
    return (await this.prepare(scope, ref, version, signal))(issue);
  }

  /** Authenticate before batch media verification; retain only immutable identity, never ciphertext. */
  async prepare(
    scope: ShortsScope,
    ref: PrivateObjectRef,
    version: string,
    signal: AbortSignal,
  ) {
    scope = Object.freeze({ network: scope.network, contract: scope.contract });
    ref = Object.freeze({
      key: ref.key,
      keyId: ref.keyId,
      bytes: ref.bytes,
      sha256: ref.sha256,
    });
    // An immutable candidate must authenticate completely before any removal grant.
    // Verifying a different current copy is insufficient when this is the last copy.
    await this.objects.verifyStoredVersion(scope, ref, version, signal);
    await this.storage.preflightRetired(ref.key, version, ref.bytes, signal);
    signal.throwIfAborted();
    let used = false;
    return async (issue: PrivateVersionIssuer) => {
      signal.throwIfAborted();
      if (used)
        throw new Error('Prepared private deletion was already consumed');
      used = true;
      const dispatch = await issue(scope, ref, version);
      signal.throwIfAborted();
      if (
        dispatch.scope?.network !== scope.network ||
        dispatch.scope?.contract !== scope.contract ||
        dispatch.ref?.key !== ref.key ||
        dispatch.ref?.keyId !== ref.keyId ||
        dispatch.ref?.bytes !== ref.bytes ||
        dispatch.ref?.sha256 !== ref.sha256 ||
        dispatch.version !== version
      )
        throw new Error('Retired version authority identity changed');
      await this.storage.removeRetiredVersion(
        ref.key,
        version,
        ref.bytes,
        dispatch.issuedAt,
        signal,
        dispatch.assertCurrent,
        dispatch.expiresAt,
      );
      return { key: ref.key, version, removed: true as const };
    };
  }

  /** Recovery observation only; the journal must establish an issued attempt first. */
  async absent(
    scope: ShortsScope,
    ref: PrivateObjectRef,
    version: string,
    signal: AbortSignal,
  ) {
    this.objects.validateReference(scope, ref);
    const { key, bytes } = ref;
    await this.storage.ready(signal);
    return this.storage.retiredVersionAbsent(key, version, bytes, signal);
  }
}
