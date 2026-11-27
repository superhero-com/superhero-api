import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { ProfileMediaAuth } from './profile-media-auth.service';
import { ProfileMediaAssets } from './profile-media-assets.service';
import { ProfileMediaDatabase } from './profile-media-database.service';
import {
  ProfileMediaUploads,
  IMAGE_PART_BYTES,
} from './profile-media-uploads.service';
import { profileImageHash } from './profile-media-storage.service';

/** The dedicated image container owns decoding, IPFS writes and byte delivery. */
@Injectable()
export class ProfileMediaWorker implements OnModuleDestroy {
  private current?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly db: ProfileMediaDatabase,
    private readonly auth: ProfileMediaAuth,
    private readonly uploads: ProfileMediaUploads,
    private readonly assets: ProfileMediaAssets,
  ) {}
  @Cron('*/2 * * * * *')
  async tick() {
    if (this.stopping || this.current || !this.uploads.config.enabled) return;
    this.current = this.process()
      .catch(() => {})
      .finally(() => {
        this.current = undefined;
      });
    await this.current;
  }
  async process() {
    const scope = this.uploads.config.scope;
    const slot = await this.auth.acquireUpload();
    try {
      await this.db.query(
        `UPDATE profile_media_uploads SET state='failed',error='Image processing could not complete',lease=NULL,lease_until=NULL
        WHERE scope=$1 AND state='processing' AND lease_until<now() AND attempts>=3`,
        [scope],
      );
      const lease = randomUUID();
      const [job] = await this.db.query(
        `WITH next AS (
        SELECT id FROM profile_media_uploads WHERE scope=$1 AND attempts<3 AND (state='queued' OR (state='processing' AND lease_until<now()))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1), claimed AS (
        UPDATE profile_media_uploads u SET state='processing',lease=$2,lease_until=now()+interval '240 seconds',attempts=attempts+1,updated_at=now()
        FROM next WHERE u.scope=$1 AND u.id=next.id RETURNING u.*) SELECT * FROM claimed`,
        [scope, lease],
      );
      if (!job) return;
      try {
        const signal = AbortSignal.timeout(60000);
        const chunks: Buffer[] = [];
        for (
          let index = 0;
          index < Math.ceil(job.bytes / IMAGE_PART_BYTES);
          index++
        ) {
          const part = job.parts[index];
          if (!part?.complete) throw new Error('Incomplete source');
          chunks.push(
            await this.uploads.objects.get(
              this.uploads.scope(),
              part.object,
              signal,
            ),
          );
        }
        const bytes = Buffer.concat(chunks);
        if (
          bytes.length !== job.bytes ||
          profileImageHash(bytes) !== job.sha256
        )
          throw new Error('Source mismatch');
        const image = await this.assets.prepare(job.address, job.role, bytes);
        await this.db.query(
          `UPDATE profile_media_uploads SET state='ready',cid=$4,lease=NULL,lease_until=NULL,error=NULL,updated_at=now()
          WHERE scope=$1 AND id=$2 AND lease=$3 AND state='processing'`,
          [scope, job.id, lease, image.cid],
        );
      } catch (error) {
        const invalid =
          error instanceof Error &&
          'getStatus' in error &&
          typeof error.getStatus === 'function' &&
          error.getStatus() === 400;
        await this.db.query(
          `UPDATE profile_media_uploads SET state=$4,error=$5,lease=NULL,lease_until=NULL,updated_at=now() WHERE scope=$1 AND id=$2 AND lease=$3 AND state='processing'`,
          [
            scope,
            job.id,
            lease,
            invalid || job.attempts >= 3 ? 'failed' : 'queued',
            invalid
              ? 'Choose a valid still JPEG, PNG or WebP image up to 24 megapixels.'
              : 'Image processing is unavailable. Please try again later.',
          ],
        );
      }
    } finally {
      await this.auth.releaseUpload(slot);
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    await this.current;
  }
}
