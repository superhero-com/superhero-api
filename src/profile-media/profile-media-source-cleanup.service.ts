import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import {
  PrivateBucketConfig,
  PrivateObjectRef,
} from '../shorts/shorts-private-objects.service';
import { ProfileMediaUploads } from './profile-media-uploads.service';

export const PROFILE_MEDIA_CLEANUP_BUCKET = Symbol(
  'PROFILE_MEDIA_CLEANUP_BUCKET',
);

/** Delete authority is confined to this module and profile upload keys. */
@Injectable()
export class ProfileMediaSourceCleanup implements OnModuleDestroy {
  private readonly client?: S3Client;
  constructor(
    @Inject(PROFILE_MEDIA_CLEANUP_BUCKET)
    private readonly config: PrivateBucketConfig | null,
    private readonly uploads: ProfileMediaUploads,
  ) {
    if (config)
      this.client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: config.credentials,
        forcePathStyle: config.forcePathStyle,
        followRegionRedirects: false,
        maxAttempts: 2,
        requestHandler: {
          connectionTimeout: 5000,
          requestTimeout: 10000,
          throwOnRequestTimeout: true,
        },
      });
  }
  async remove(id: string, index: string, ref: PrivateObjectRef) {
    if (
      !this.config ||
      !this.client ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      !/^[0-9]$/.test(index)
    )
      throw new Error('Invalid profile source cleanup');
    this.uploads.objects.validateReference(this.uploads.scope(), ref);
    const scope = this.uploads.scope();
    const namespace = createHash('sha256')
      .update(JSON.stringify([scope.network, scope.contract]))
      .digest('hex');
    const expected = `${this.config.prefix}/${namespace}/profile-${id}/direct-part/${index}/${ref.keyId}/${ref.sha256}`;
    if (ref.key !== expected)
      throw new Error('Profile source cleanup scope mismatch');
    const options = { abortSignal: AbortSignal.timeout(15000) };
    const versions: string[] = [];
    let keyMarker: string | undefined, versionMarker: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.config.bucket,
          Prefix: expected,
          MaxKeys: 100,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
        options,
      );
      for (const item of [
        ...(result.Versions || []),
        ...(result.DeleteMarkers || []),
      ]) {
        if (item.Key !== expected) continue;
        if (!item.VersionId || item.VersionId.length > 1024)
          throw new Error('Invalid profile source version');
        versions.push(item.VersionId);
      }
      if (!result.IsTruncated) break;
      if (
        page === 9 ||
        !result.NextKeyMarker ||
        (result.NextKeyMarker === keyMarker &&
          result.NextVersionIdMarker === versionMarker)
      )
        throw new Error('Incomplete profile source version inventory');
      keyMarker = result.NextKeyMarker;
      versionMarker = result.NextVersionIdMarker;
    }
    for (const version of new Set(versions))
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: expected,
          VersionId: version,
        }),
        options,
      );
    // Explicit version deletion also handles an unversioned object's "null"
    // version, and never creates a new delete marker instead of freeing bytes.
    const remaining = await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: this.config.bucket,
        Prefix: expected,
        MaxKeys: 1,
      }),
      options,
    );
    if (
      [...(remaining.Versions || []), ...(remaining.DeleteMarkers || [])].some(
        (item) => item.Key === expected,
      )
    )
      throw new Error('Profile source cleanup is incomplete');
  }
  onModuleDestroy() {
    this.client?.destroy();
  }
}
