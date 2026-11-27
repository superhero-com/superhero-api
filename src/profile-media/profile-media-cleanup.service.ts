import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ProfileMediaDatabase } from './profile-media-database.service';
import { ProfileMediaStorage } from './profile-media-storage.service';
import { ProfileMediaSourceCleanup } from './profile-media-source-cleanup.service';
import {
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';

/** Restartable deletion journal, running only in the dedicated image worker. */
@Injectable()
export class ProfileMediaCleanup implements OnModuleDestroy {
  private current?: Promise<void>;
  private stopping = false;
  private readonly logger = new Logger(ProfileMediaCleanup.name);
  constructor(
    private readonly db: ProfileMediaDatabase,
    private readonly storage: ProfileMediaStorage,
    private readonly sources: ProfileMediaSourceCleanup,
    @Inject(PROFILE_MEDIA_CONFIG) private readonly config: ProfileMediaConfig,
  ) {}
  @Cron('*/30 * * * * *')
  async tick() {
    if (!this.config.enabled || this.stopping || this.current) return;
    this.current = this.process()
      .catch(() => {
        this.logger.warn('Profile image cleanup deferred');
      })
      .finally(() => {
        this.current = undefined;
      });
    await this.current;
  }
  async process() {
    const db = this.db.createQueryRunner();
    await db.connect();
    const key = `profile-media-cleanup:${this.config.scope}`;
    let locked = false;
    try {
      const [lock] = await db.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
        [key],
      );
      locked = lock.locked;
      if (!locked) return;
      const rows = await db.query(
        `SELECT cid,cleanup_blocks FROM profile_media_assets
        WHERE scope=$1 AND cleanup_requested_at IS NOT NULL AND deleted_at IS NULL
        AND NOT ready AND cleanup_retry_at<=now() ORDER BY cleanup_retry_at LIMIT 5`,
        [this.config.scope],
      );
      for (const row of rows) {
        try {
          const blocks =
            row.cleanup_blocks || (await this.storage.blocks(row.cid));
          // Persist the entire DAG before unpinning or removing its first block.
          // A crash midway through deletion must not require traversing it again.
          if (!row.cleanup_blocks)
            await db.query(
              `UPDATE profile_media_assets SET cleanup_blocks=$3 WHERE scope=$1 AND cid=$2`,
              [this.config.scope, row.cid, JSON.stringify(blocks)],
            );
          await this.storage.remove(row.cid, blocks);
          await db.query(
            `UPDATE profile_media_assets SET deleted_at=now(),cleanup_retry_at=NULL WHERE scope=$1 AND cid=$2`,
            [this.config.scope, row.cid],
          );
        } catch {
          await db.query(
            `UPDATE profile_media_assets SET cleanup_retry_at=now()+interval '5 minutes' WHERE scope=$1 AND cid=$2`,
            [this.config.scope, row.cid],
          );
          this.logger.warn('An old profile image will be retried for cleanup');
        }
      }
      // Expired upload permissions cannot recreate removed temporary objects.
      // Allow another hour for any upload already in flight to drain.
      const uploads = await db.query(
        `SELECT id,parts FROM profile_media_uploads WHERE scope=$1
        AND source_deleted_at IS NULL AND expires_at<now()-interval '1 hour'
        AND state IN ('ready','failed','uploading') ORDER BY expires_at LIMIT 10`,
        [this.config.scope],
      );
      for (const upload of uploads) {
        try {
          for (const [index, part] of Object.entries(upload.parts))
            await this.sources.remove(upload.id, index, (part as any).object);
          await db.query(
            `UPDATE profile_media_uploads SET source_deleted_at=now(),
            state=CASE WHEN state='uploading' THEN 'failed' ELSE state END
            WHERE scope=$1 AND id=$2`,
            [this.config.scope, upload.id],
          );
        } catch {
          this.logger.warn(
            'A temporary profile upload will be retried for cleanup',
          );
        }
      }
    } finally {
      if (locked)
        await db
          .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key])
          .catch(() => {});
      await db.release();
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    await this.current;
  }
}
