import {
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ListObjectVersionsCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  StorageInventoryConfig,
  SHORTS_STORAGE_INVENTORY_CONFIG,
} from './shorts-storage-inventory.config';

export interface StorageCursor {
  key: string;
  version: string;
}
export interface StorageEntry {
  key: string;
  version: string;
  deleted: boolean;
  latest: boolean;
  bytes: number;
  modifiedAt: string;
}
export interface StoragePage {
  entries: StorageEntry[];
  next: StorageCursor | null;
}
export interface MultipartCursor {
  key: string;
  uploadId: string;
}
export interface MultipartUpload extends MultipartCursor {
  initiatedAt: string;
}
export interface MultipartPart {
  number: number;
  bytes: number;
  modifiedAt: string;
  etag: string;
}
export interface MultipartPartsPage {
  entries: MultipartPart[];
  next: number | null;
  unavailable: boolean;
}
const opaque = (value: unknown, max: number) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('\0') &&
  Buffer.byteLength(value, 'utf8') <= max;

/** Metadata-only S3 client. No object download, write, deletion or decryption capability. */
@Injectable()
export class ShortsStorageListService implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly shutdown = new AbortController();
  constructor(
    @Inject(SHORTS_STORAGE_INVENTORY_CONFIG)
    private readonly config: StorageInventoryConfig,
  ) {
    this.client = new S3Client({
      endpoint: config.storage.endpoint,
      region: config.storage.region,
      credentials: config.storage.credentials,
      forcePathStyle: config.storage.forcePathStyle,
      followRegionRedirects: false,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 1000,
        requestTimeout: 8000,
        throwOnRequestTimeout: true,
      },
    });
    // Bound raw XML/error bytes before the SDK buffers or deserializes them.
    const handler = this.client.config.requestHandler;
    const handle = handler.handle.bind(handler);
    handler.handle = async (request, options) => {
      const result = await handle(request, options);
      const stream = result.response.body as Readable;
      if (!(stream instanceof Readable))
        throw new Error('Unsupported inventory transport');
      const signal = options?.abortSignal;
      const abort = () => stream.destroy(new Error('Storage listing aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) throw new Error('Storage listing aborted');
        const declared = result.response.headers['content-length'];
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1048576))
          throw new Error('Storage listing too large');
        const body = Buffer.alloc(1048576);
        let bytes = 0;
        for await (const value of stream) {
          const chunk = Buffer.from(value);
          if (bytes + chunk.length > body.length || signal?.aborted)
            throw new Error('Storage listing too large or interrupted');
          chunk.copy(body, bytes);
          bytes += chunk.length;
        }
        result.response.body = body.subarray(0, bytes);
        return result;
      } finally {
        signal?.removeEventListener('abort', abort);
        stream.destroy();
      }
    };
  }
  onModuleDestroy() {
    this.shutdown.abort();
    this.client.destroy();
  }
  private abort(signal?: AbortSignal) {
    return AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]);
  }
  private uploadIdentity(value: MultipartCursor) {
    if (
      !value ||
      !opaque(value.key, 1024) ||
      !value.key.startsWith(this.config.objectPrefix) ||
      !opaque(value.uploadId, 1024)
    )
      throw new Error('Invalid multipart identity');
  }
  async multipartUploads(
    cursor: MultipartCursor | null,
    signal?: AbortSignal,
  ): Promise<{ entries: MultipartUpload[]; next: MultipartCursor | null }> {
    const abortSignal = this.abort(signal);
    try {
      abortSignal.throwIfAborted();
      if (cursor) this.uploadIdentity(cursor);
      const response = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.config.storage.bucket,
          Prefix: this.config.objectPrefix,
          MaxUploads: 100,
          KeyMarker: cursor?.key,
          UploadIdMarker: cursor?.uploadId,
        }),
        { abortSignal },
      );
      abortSignal.throwIfAborted();
      if (
        response.Bucket !== this.config.storage.bucket ||
        response.Prefix !== this.config.objectPrefix ||
        typeof response.IsTruncated !== 'boolean' ||
        response.CommonPrefixes?.length ||
        response.Delimiter ||
        response.EncodingType
      )
        throw new Error('Unexpected multipart listing scope');
      const entries = (response.Uploads || []).map((row) => {
        const entry = { key: row.Key, uploadId: row.UploadId };
        this.uploadIdentity(entry);
        if (
          !(row.Initiated instanceof Date) ||
          !Number.isFinite(row.Initiated.getTime())
        )
          throw new Error('Invalid upload time');
        return { ...entry, initiatedAt: row.Initiated.toISOString() };
      });
      if (
        entries.length > 100 ||
        new Set(entries.map((row) => JSON.stringify([row.key, row.uploadId])))
          .size !== entries.length
      )
        throw new Error('Invalid multipart page');
      let next: MultipartCursor | null = null;
      if (response.IsTruncated) {
        next = {
          key: response.NextKeyMarker,
          uploadId: response.NextUploadIdMarker,
        };
        this.uploadIdentity(next);
        if (
          !entries.length ||
          (cursor &&
            ((next.key === cursor.key && next.uploadId === cursor.uploadId) ||
              Buffer.compare(Buffer.from(next.key), Buffer.from(cursor.key)) <
                0))
        )
          throw new Error('Multipart cursor did not advance');
      }
      return { entries, next };
    } catch {
      throw new ServiceUnavailableException(
        'Multipart upload listing unavailable; checkpoint unchanged',
      );
    }
  }
  async multipartParts(
    upload: MultipartCursor,
    marker = 0,
    signal?: AbortSignal,
  ): Promise<MultipartPartsPage> {
    const abortSignal = this.abort(signal);
    try {
      abortSignal.throwIfAborted();
      this.uploadIdentity(upload);
      if (!Number.isSafeInteger(marker) || marker < 0 || marker > 10000)
        throw new Error('Invalid part marker');
      const response = await this.client.send(
        new ListPartsCommand({
          Bucket: this.config.storage.bucket,
          Key: upload.key,
          UploadId: upload.uploadId,
          MaxParts: 100,
          PartNumberMarker: marker ? String(marker) : undefined,
        }),
        { abortSignal },
      );
      abortSignal.throwIfAborted();
      if (
        response.Bucket !== this.config.storage.bucket ||
        response.Key !== upload.key ||
        response.UploadId !== upload.uploadId ||
        typeof response.IsTruncated !== 'boolean'
      )
        throw new Error('Unexpected part listing scope');
      let previous = marker;
      const entries = (response.Parts || []).map((row) => {
        if (
          !Number.isSafeInteger(row.PartNumber) ||
          row.PartNumber <= previous ||
          row.PartNumber > 10000 ||
          !Number.isSafeInteger(row.Size) ||
          row.Size < 0 ||
          !opaque(row.ETag, 1024) ||
          !(row.LastModified instanceof Date) ||
          !Number.isFinite(row.LastModified.getTime())
        )
          throw new Error('Invalid part observation');
        previous = row.PartNumber;
        return {
          number: row.PartNumber,
          bytes: row.Size,
          modifiedAt: row.LastModified.toISOString(),
          etag: row.ETag,
        };
      });
      if (entries.length > 100) throw new Error('Too many parts');
      let next: number | null = null;
      if (response.IsTruncated) {
        if (!/^[1-9][0-9]{0,4}$/.test(response.NextPartNumberMarker || ''))
          throw new Error('Invalid part marker');
        next = Number(response.NextPartNumberMarker);
        if (
          !entries.length ||
          !Number.isSafeInteger(next) ||
          next <= marker ||
          next !== previous ||
          next > 10000
        )
          throw new Error('Part marker did not advance');
      }
      return { entries, next, unavailable: false };
    } catch (error) {
      // Only an explicit provider NoSuchUpload is an observed disappearance. Other failures preserve the checkpoint.
      if (
        !abortSignal.aborted &&
        error instanceof S3ServiceException &&
        error.name === 'NoSuchUpload' &&
        error?.$metadata?.httpStatusCode === 404
      )
        return { entries: [], next: null, unavailable: true };
      throw new ServiceUnavailableException(
        'Multipart parts unavailable; checkpoint unchanged',
      );
    }
  }
  async page(
    cursor: StorageCursor | null,
    signal?: AbortSignal,
  ): Promise<StoragePage> {
    const abortSignal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]);
    try {
      abortSignal.throwIfAborted();
      if (
        cursor &&
        (!opaque(cursor.key, 1024) ||
          !cursor.key.startsWith(this.config.objectPrefix) ||
          !opaque(cursor.version, 1024))
      )
        throw new Error('Invalid storage cursor');
      const response = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.config.storage.bucket,
          Prefix: this.config.objectPrefix,
          MaxKeys: 100,
          KeyMarker: cursor?.key,
          VersionIdMarker: cursor?.version,
        }),
        { abortSignal },
      );
      abortSignal.throwIfAborted();
      if (
        response.Name !== this.config.storage.bucket ||
        response.Prefix !== this.config.objectPrefix ||
        typeof response.IsTruncated !== 'boolean' ||
        response.CommonPrefixes?.length ||
        response.Delimiter ||
        response.EncodingType
      )
        throw new Error('Unexpected storage listing scope');
      const entries: StorageEntry[] = [];
      for (const [deleted, rows] of [
        [false, response.Versions || []],
        [true, response.DeleteMarkers || []],
      ] as const) {
        for (const row of rows) {
          const bytes = deleted ? 0 : 'Size' in row ? row.Size : undefined;
          if (
            !opaque(row.Key, 1024) ||
            !row.Key.startsWith(this.config.objectPrefix) ||
            !opaque(row.VersionId, 1024) ||
            typeof row.IsLatest !== 'boolean' ||
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            !(row.LastModified instanceof Date) ||
            !Number.isFinite(row.LastModified.getTime())
          )
            throw new Error('Invalid storage listing entry');
          entries.push({
            key: row.Key,
            version: row.VersionId,
            deleted,
            latest: row.IsLatest,
            bytes,
            modifiedAt: row.LastModified.toISOString(),
          });
        }
      }
      if (
        entries.length > 100 ||
        new Set(
          entries.map((e) => JSON.stringify([e.key, e.version, e.deleted])),
        ).size !== entries.length
      )
        throw new Error('Duplicate or oversized storage page');
      let next: StorageCursor | null = null;
      if (response.IsTruncated) {
        if (
          !entries.length ||
          !opaque(response.NextKeyMarker, 1024) ||
          !response.NextKeyMarker.startsWith(this.config.objectPrefix) ||
          !opaque(response.NextVersionIdMarker, 1024)
        )
          throw new Error('Incomplete storage cursor');
        next = {
          key: response.NextKeyMarker,
          version: response.NextVersionIdMarker,
        };
        if (
          cursor &&
          (JSON.stringify(next) === JSON.stringify(cursor) ||
            Buffer.compare(Buffer.from(next.key), Buffer.from(cursor.key)) < 0)
        )
          throw new Error('Storage cursor did not advance');
      }
      return { entries, next };
    } catch {
      throw new ServiceUnavailableException(
        'Private storage inventory could not be read; its checkpoint has not advanced',
      );
    }
  }
}
