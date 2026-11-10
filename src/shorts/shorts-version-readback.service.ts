import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ShortsScope } from './shorts-metadata.service';
import {
  PRIVATE_OBJECT_OVERHEAD,
  PrivateObjectRef,
  ShortsPrivateObjectsService,
} from './shorts-private-objects.service';
import {
  SHORTS_STORAGE_RECONCILIATION_CONFIG,
  StorageReconciliationConfig,
} from './shorts-storage-reconciliation.config';
import { discardShortsResponse, readShortsJson } from './shorts-upstream';
import {
  versionReadbackProof,
  validObjectVersion,
} from './shorts-transfer-protocol';

@Injectable()
export class ShortsVersionReadbackService {
  private readonly origin?: string;
  private readonly keyFile?: string;
  constructor(
    @Inject(SHORTS_STORAGE_RECONCILIATION_CONFIG)
    private readonly deployment: StorageReconciliationConfig,
    private readonly objects: ShortsPrivateObjectsService,
  ) {
    const endpoint = process.env.SHORTS_VERSION_READBACK_URL;
    this.keyFile = process.env.SHORTS_VERSION_READBACK_KEY_FILE;
    if (!endpoint && !this.keyFile) return;
    if (!endpoint) throw new Error('Missing private version readback endpoint');
    const url = new URL(endpoint);
    const local =
      process.env.NODE_ENV !== 'production' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      !isAbsolute(this.keyFile || '')
    )
      throw new Error(
        'Invalid private version readback endpoint or credential',
      );
    this.origin = url.origin;
  }
  validateReference(scope: ShortsScope, ref: PrivateObjectRef) {
    return this.objects.validateReference(scope, ref);
  }
  async verifyVersionCopies(
    scope: ShortsScope,
    ref: PrivateObjectRef,
    candidate: string,
    signal?: AbortSignal,
  ) {
    if (!this.origin)
      return this.objects.verifyVersionCopies(scope, ref, candidate, signal);
    const result = await this.remote(scope, ref, candidate, 'pair', signal);
    return {
      key: ref.key,
      retainedVersion: result.retainedVersion as string,
      candidateVersion: candidate,
      plaintextBytes: ref.bytes,
      storedBytes: result.storedBytes as number,
      sha256: ref.sha256,
    };
  }
  async verifyStoredVersion(
    scope: ShortsScope,
    ref: PrivateObjectRef,
    version: string,
    signal?: AbortSignal,
  ) {
    if (!this.origin)
      return this.objects.verifyStoredVersion(scope, ref, version, signal);
    await this.remote(scope, ref, version, 'single', signal);
  }
  private async remote(
    scope: ShortsScope,
    ref: PrivateObjectRef,
    version: string,
    mode: 'single' | 'pair',
    parent?: AbortSignal,
  ) {
    this.objects.validateReference(scope, ref);
    if (
      scope.network !== this.deployment.scope.network ||
      scope.contract !== this.deployment.scope.contract ||
      !validObjectVersion(version)
    )
      throw new Error('Invalid immutable version identity');
    const expires = Date.now() + 120000;
    const signal = AbortSignal.any([
      AbortSignal.timeout(120000),
      ...(parent ? [parent] : []),
    ]);
    const key = (
      await readFile(this.keyFile, { encoding: 'utf8', signal })
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('Invalid private version readback credential');
    const request = JSON.stringify({
      version: 1,
      challenge: randomBytes(32).toString('hex'),
      expires,
      scope,
      sourceHash: this.deployment.sourceHash,
      storageId: this.deployment.storageId,
      object: {
        key: ref.key,
        keyId: ref.keyId,
        bytes: ref.bytes,
        sha256: ref.sha256,
      },
      objectVersion: version,
      mode,
    });
    try {
      const response = await fetch(
        this.origin + '/internal/media/verify-versions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
          },
          redirect: 'error',
          signal,
          body: request,
        },
      );
      if (response.status !== 200) {
        discardShortsResponse(response);
        throw new Error('Storage readback unavailable');
      }
      const reply = await readShortsJson(response, 16384, signal),
        r = reply?.receipt;
      if (
        reply?.version !== 1 ||
        !r ||
        r.key !== ref.key ||
        r.plaintextBytes !== ref.bytes ||
        r.sha256 !== ref.sha256 ||
        !validObjectVersion(r.retainedVersion) ||
        (mode === 'pair'
          ? r.candidateVersion !== version ||
            r.retainedVersion === version ||
            r.storedBytes !== ref.bytes + PRIVATE_OBJECT_OVERHEAD
          : r.retainedVersion !== version || r.candidateVersion !== null) ||
        typeof reply.proof !== 'string' ||
        !/^[a-f0-9]{64}$/.test(reply.proof) ||
        !timingSafeEqual(
          Buffer.from(reply.proof, 'hex'),
          Buffer.from(versionReadbackProof(key, request, r), 'hex'),
        ) ||
        Date.now() >= expires
      )
        throw new Error('Invalid immutable version receipt');
      signal.throwIfAborted();
      return r;
    } catch {
      parent?.throwIfAborted();
      throw new ServiceUnavailableException(
        'Private object versions could not be verified',
      );
    }
  }
}
