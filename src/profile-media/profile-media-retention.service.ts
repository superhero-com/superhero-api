import { profileImageCid } from './image-reference';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ProfileMediaDatabase } from './profile-media-database.service';
import { ProfileMediaChain } from './profile-media-chain.service';
import {
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';

// Recheck this predicate under the asset row lock, shared with claim(). A queued
// deletion makes ready=false before the worker can remove any bytes.
const eligible = `a.scope=$1 AND a.ready AND a.deleted_at IS NULL AND a.cleanup_requested_at IS NULL
  AND ((a.role IN ('avatar','cover') AND a.replaced_at < now()-interval '1 minute')
    OR (a.last_linked_at IS NULL AND a.created_at < now()-interval '24 hours'))
  AND NOT EXISTS (SELECT 1 FROM profile_media_writes w WHERE w.scope=a.scope
    AND w.address=a.address AND w.role=a.role
    AND (w.state IN ('signed','submitted')
      OR (w.cid=a.cid AND w.state='prepared' AND w.expires_at>now())))
  AND NOT EXISTS (SELECT 1 FROM profile_media_uploads u WHERE u.scope=a.scope
    AND u.address=a.address AND u.role=a.role
    AND (u.state IN ('queued','processing')
      OR (u.cid=a.cid AND u.state='ready' AND u.expires_at>now() AND u.created_at>a.replaced_at)))`;

/** API-side authorization only; the image worker owns physical deletion. */
@Injectable()
export class ProfileMediaRetention {
  private running = false;
  private readonly logger = new Logger(ProfileMediaRetention.name);
  constructor(
    private readonly db: ProfileMediaDatabase,
    private readonly chain: ProfileMediaChain,
    @Inject(PROFILE_MEDIA_CONFIG) private readonly config: ProfileMediaConfig,
  ) {}

  @Cron('*/30 * * * * *')
  async tick() {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    try {
      await this.process();
    } catch {
      this.logger.warn('Profile image retention check deferred');
    } finally {
      this.running = false;
    }
  }

  async process() {
    const rows = await this.db.query(
      `SELECT a.cid,a.address,a.role FROM profile_media_assets a WHERE ${eligible} ORDER BY a.created_at LIMIT 10`,
      [this.config.scope],
    );
    for (const row of rows) {
      const db = this.db.createQueryRunner();
      await db.connect();
      let locked = false;
      try {
        // Serialize with provider submissions, including their signed-tx journal.
        const [lock] = await db.query(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [`profile-media:${this.chain.providerAddress}`],
        );
        locked = lock.locked;
        if (!locked) return;
        const links =
          row.role === 'post' ? {} : await this.chain.links(row.address); // Never use the profile read cache.
        await db.startTransaction();
        await db.query(
          'SELECT cid FROM profile_media_assets WHERE scope=$1 AND cid=$2 FOR UPDATE',
          [this.config.scope, row.cid],
        );
        // New statement/snapshot after obtaining the lock: a concurrent claim
        // may have inserted its prepared write while this row lock was waiting.
        const [asset] = await db.query(
          `SELECT a.cid FROM profile_media_assets a WHERE ${eligible} AND a.cid=$2`,
          [this.config.scope, row.cid],
        );
        if (asset) {
          if (
            Object.values(links).some(
              (value) => profileImageCid(value) === row.cid,
            )
          ) {
            await db.query(
              `UPDATE profile_media_assets SET replaced_at=NULL,last_linked_at=now() WHERE scope=$1 AND cid=$2`,
              [this.config.scope, row.cid],
            );
          } else {
            await db.query(
              `UPDATE profile_media_assets SET ready=false,cleanup_requested_at=now(),cleanup_retry_at=now()
              WHERE scope=$1 AND cid=$2`,
              [this.config.scope, row.cid],
            );
          }
        }
        await db.commitTransaction();
      } finally {
        if (db.isTransactionActive) await db.rollbackTransaction();
        if (locked)
          await db
            .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
              `profile-media:${this.chain.providerAddress}`,
            ])
            .catch(() => {});
        await db.release();
      }
    }
  }
}
