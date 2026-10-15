import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ShortsSourceReaderService } from './shorts-source-reader.service';
import { createHash } from 'node:crypto';
import { ShortsMetadataService, ShortsScope } from './shorts-metadata.service';
import { ShortsPrivateObjectsService } from './shorts-private-objects.service';
import {
  SHORTS_PART_BYTES,
  ShortsUploadRecordsService,
} from './shorts-upload-records.service';

/** No decoder or signer. Coordinates private byte IO with shared immutable upload records. */
@Injectable()
export class ShortsSourceService extends ShortsSourceReaderService {
  constructor(
    private readonly uploads: ShortsUploadRecordsService,
    objects: ShortsPrivateObjectsService,
    private readonly metadata: ShortsMetadataService,
  ) {
    super(objects);
  }
  assertDirectUploadsConfigured() {
    this.objects.assertDirectUploadsConfigured();
  }

  async prepareDirect(
    scope: ShortsScope,
    id: string,
    creator: string,
    index: number,
    sha256: string,
  ) {
    const upload = await this.uploads.get(scope, id, creator);
    const bytes = Math.min(
      SHORTS_PART_BYTES,
      upload.input.bytes - index * SHORTS_PART_BYTES,
    );
    const ref = this.objects.directReference(scope, id, index, bytes, sha256);
    const part = await this.uploads.reserveDirect(
      scope,
      id,
      creator,
      index,
      ref,
    );
    return this.objects.directEncryption(scope, part.object, part.iv);
  }
  async authorizeDirect(
    scope: ShortsScope,
    id: string,
    creator: string,
    index: number,
    checksum: string,
  ) {
    const { part, expiresAt } = await this.uploads.bindDirectChecksum(
      scope,
      id,
      creator,
      index,
      checksum,
    );
    return this.objects.directUrl(scope, part.object, checksum, expiresAt);
  }
  async completeDirect(
    scope: ShortsScope,
    id: string,
    creator: string,
    index: number,
    signal?: AbortSignal,
  ) {
    const upload = await this.uploads.get(scope, id, creator);
    if (!Number.isInteger(index) || index < 0 || index > 39)
      throw new BadRequestException('Invalid upload part');
    if (upload.parts.some((part) => part.index === index)) return;
    const part = upload.directParts[index];
    if (!part?.checksum)
      throw new ConflictException('Upload this video part first');
    await this.objects.verifyDirect(scope, part.object, part.checksum, signal);
    await this.uploads.part(scope, id, creator, index, part.object);
  }

  async part(
    scope: ShortsScope,
    id: string,
    creator: string,
    index: number,
    bytes: Buffer,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const upload = await this.uploads.get(scope, id, creator);
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= Math.ceil(upload.input.bytes / SHORTS_PART_BYTES) ||
      !Buffer.isBuffer(bytes) ||
      bytes.length !==
        Math.min(
          SHORTS_PART_BYTES,
          upload.input.bytes - index * SHORTS_PART_BYTES,
        )
    )
      throw new BadRequestException('Incorrect upload part');
    const existing = upload.parts.find((part) => part.index === index);
    if (existing) {
      if (
        existing.object.sha256 !==
        createHash('sha256').update(bytes).digest('hex')
      )
        throw new ConflictException(
          'This part already contains different bytes',
        );
      return existing.object;
    }
    if (upload.state !== 'uploading')
      throw new ConflictException('Upload is already being prepared');
    const ref = await this.objects.put(
      scope,
      id,
      `part/${index}`,
      bytes,
      signal,
    );
    signal?.throwIfAborted();
    // A crash before this commit leaves an unreferenced object, never a falsely
    // accepted part. A retry of the same bytes recovers the same immutable key.
    return this.uploads.part(scope, id, creator, index, ref);
  }
  async finish(
    scope: ShortsScope,
    id: string,
    creator: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const upload = await this.uploads.seal(scope, id, creator);
    signal?.throwIfAborted();
    if (upload.state === 'enqueued')
      return this.metadata.getJob(scope, creator, id);
    const manifest = Buffer.from(
      JSON.stringify({
        version: 1,
        id,
        creator,
        bytes: upload.input.bytes,
        sha256: upload.input.sha256,
        parts: upload.parts,
      }),
    );
    const ref = await this.objects.put(
      scope,
      id,
      'source-manifest',
      manifest,
      signal,
    );
    signal?.throwIfAborted();
    // This transaction commits both the accepted job and the upload state. No
    // object-store or network operation occurs under the PostgreSQL locks.
    return this.uploads.enqueue(scope, id, creator, ref);
  }
}
