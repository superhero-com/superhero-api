import { randomUUID } from 'node:crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  SHORTS_STORAGE_RECONCILIATION_CONFIG,
  StorageReconciliationConfig,
} from './shorts-storage-reconciliation.config';

/** Dedicated cleanup credentials. Ordinary workers never receive this client or DeleteObjectVersion permission. */
@Injectable()
export class ShortsPrivateVersionStorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  constructor(
    @Inject(SHORTS_STORAGE_RECONCILIATION_CONFIG)
    private readonly config: StorageReconciliationConfig,
  ) {
    this.client = new S3Client({
      ...config.storage,
      followRegionRedirects: false,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 5000,
        requestTimeout: 15000,
        throwOnRequestTimeout: true,
      },
    });
  }
  onModuleDestroy() {
    this.client.destroy();
  }
  private args(key: string, version?: string) {
    if (
      !key?.startsWith(this.config.objectPrefix) ||
      !/^[a-zA-Z0-9_/-]{1,512}$/.test(key) ||
      key.includes('//') ||
      (version !== undefined &&
        (!version ||
          version === 'null' ||
          version.includes('\0') ||
          Buffer.byteLength(version) > 1024))
    )
      throw new Error('Invalid version storage identity');
    return {
      Bucket: this.config.storage.bucket,
      Key: key,
      ...(version ? { VersionId: version } : {}),
    };
  }
  async ready(signal: AbortSignal) {
    signal.throwIfAborted();
    const versioning = await this.client.send(
      new GetBucketVersioningCommand({ Bucket: this.config.storage.bucket }),
      { abortSignal: signal },
    );
    if (versioning.Status !== 'Enabled' || versioning.MFADelete === 'Enabled')
      throw new Error(
        'Version cleanup requires enabled bucket versioning without MFA Delete',
      );
    try {
      const lifecycle = await this.client.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: this.config.storage.bucket,
        }),
        { abortSignal: signal },
      );
      if (lifecycle.Rules?.some((rule) => rule.Status === 'Enabled'))
        throw new Error(
          'Disable automatic lifecycle rules before coordinated cleanup',
        );
    } catch (error) {
      if (
        (error as { name?: string }).name !== 'NoSuchLifecycleConfiguration' ||
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 404
      )
        throw error;
    }
    signal.throwIfAborted();
  }
  async retained(
    key: string,
    version: string,
    bytes: number,
    signal: AbortSignal,
  ) {
    this.args(key, version);
    signal.throwIfAborted();
    const head = await this.client.send(new HeadObjectCommand(this.args(key)), {
      abortSignal: signal,
    });
    if (
      head.VersionId !== version ||
      head.DeleteMarker === true ||
      head.ContentLength !== bytes + 36
    )
      throw new Error('Retained version is no longer current');
  }
  async absent(
    key: string,
    candidate: string,
    retained: string,
    bytes: number,
    signal: AbortSignal,
  ) {
    if (candidate === retained)
      throw new Error('Cannot remove the retained version');
    await this.retained(key, retained, bytes, signal);
    let absent = false;
    try {
      const head = await this.client.send(
        new HeadObjectCommand(this.args(key, candidate)),
        { abortSignal: signal },
      );
      if (head.VersionId !== candidate || head.DeleteMarker === true)
        throw new Error('Candidate identity changed');
    } catch (error) {
      const failure = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        failure.$metadata?.httpStatusCode !== 404 ||
        !['NotFound', 'NoSuchKey', 'NoSuchVersion'].includes(failure.name)
      )
        throw error;
      absent = true;
    }
    await this.retained(key, retained, bytes, signal);
    signal.throwIfAborted();
    return absent;
  }
  async preflight(
    key: string,
    retained: string,
    bytes: number,
    signal: AbortSignal,
  ) {
    await this.ready(signal);
    // Confirm missing-version visibility before granting a destructive request.
    // S3 can return 403 for missing objects when the reader lacks ListBucket.
    if (!(await this.absent(key, randomUUID(), retained, bytes, signal)))
      throw new Error('Missing-version visibility could not be established');
  }

  async remove(
    key: string,
    candidate: string,
    retained: string,
    bytes: number,
    issuedAt: Date,
    parent: AbortSignal,
    beforeDelete: () => Promise<void>,
  ) {
    if (candidate === retained)
      throw new Error('Cannot remove the retained version');
    return this.dispatch(
      key,
      candidate,
      issuedAt,
      parent,
      beforeDelete,
      async (signal) => {
        await this.ready(signal);
        await this.retained(key, retained, bytes, signal);
      },
      (signal) => this.absent(key, candidate, retained, bytes, signal),
    );
  }

  /** Observes one immutable version; absence says nothing about other versions. */
  async retiredVersionAbsent(
    key: string,
    version: string,
    bytes: number,
    signal: AbortSignal,
  ) {
    const args = this.args(key, version);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 100000000)
      throw new Error('Invalid retired version length');
    signal.throwIfAborted();
    try {
      const head = await this.client.send(new HeadObjectCommand(args), {
        abortSignal: signal,
      });
      if (
        head.VersionId !== version ||
        head.DeleteMarker === true ||
        head.ContentLength !== bytes + 36
      )
        throw new Error('Retired version identity changed');
      signal.throwIfAborted();
      return false;
    } catch (error) {
      const failure = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        failure.$metadata?.httpStatusCode !== 404 ||
        !['NotFound', 'NoSuchKey', 'NoSuchVersion'].includes(failure.name)
      )
        throw error;
      signal.throwIfAborted();
      return true;
    }
  }

  async preflightRetired(
    key: string,
    version: string,
    bytes: number,
    signal: AbortSignal,
  ) {
    await this.ready(signal);
    if (await this.retiredVersionAbsent(key, version, bytes, signal))
      throw new Error('Retired version is unavailable');
    if (!(await this.retiredVersionAbsent(key, randomUUID(), bytes, signal)))
      throw new Error('Missing-version visibility could not be established');
  }

  /** Internal transport only. Call through authenticated retirement coordination. */
  async removeRetiredVersion(
    key: string,
    version: string,
    bytes: number,
    issuedAt: Date,
    parent: AbortSignal,
    beforeDelete: () => Promise<void>,
    expiresAt?: Date,
  ) {
    return this.dispatch(
      key,
      version,
      issuedAt,
      parent,
      beforeDelete,
      (signal) => this.preflightRetired(key, version, bytes, signal),
      (signal) => this.retiredVersionAbsent(key, version, bytes, signal),
      expiresAt,
    );
  }

  private async dispatch(
    key: string,
    candidate: string,
    issuedAt: Date,
    parent: AbortSignal,
    beforeDelete: () => Promise<void>,
    preflight: (signal: AbortSignal) => Promise<void>,
    confirm: (signal: AbortSignal) => Promise<boolean>,
    notAfter?: Date,
  ) {
    this.args(key, candidate);
    const signingDate = new Date(issuedAt.getTime());
    const expires = Math.min(
      signingDate.getTime() + 30000,
      notAfter?.getTime() ?? Infinity,
    );
    const expiresIn = Math.floor((expires - signingDate.getTime()) / 1000);
    if (
      !Number.isFinite(expires) ||
      expiresIn < 1 ||
      Math.abs(Date.now() - signingDate.getTime()) > 5000
    )
      throw new Error('Cleanup storage clock synchronization unavailable');
    const signal = AbortSignal.any([
      parent,
      AbortSignal.timeout(Math.max(1, expires - Date.now())),
    ]);
    await preflight(signal);
    // A paused or disconnected process cannot turn an old SQL grant into a newly signed deletion.
    const url = await getSignedUrl(
      this.client,
      new DeleteObjectCommand(this.args(key, candidate)),
      { expiresIn, signingDate },
    );
    await beforeDelete();
    signal.throwIfAborted();
    if (Date.now() >= expires) throw new Error('Cleanup dispatch expired');
    const response = await fetch(url, {
      method: 'DELETE',
      signal,
      credentials: 'omit',
      redirect: 'error',
    });
    await response.body?.cancel();
    const version = response.headers.get('x-amz-version-id');
    if (
      response.status !== 204 ||
      response.headers.get('x-amz-delete-marker') === 'true' ||
      (version && version !== candidate)
    )
      throw new Error('Version deletion outcome is uncertain');
    if (!(await confirm(signal)))
      throw new Error('Version deletion is not confirmed');
  }
}
