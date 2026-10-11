import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ShortsStoreService } from './shorts-store.service';

const HOUR = 3600000;
const MAX_BYTES = 40 * 1024 * 1024;

@Injectable()
export class ShortsUploadLimitsService {
  constructor(private readonly store: ShortsStoreService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS shorts_upload_attempts (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, created INTEGER NOT NULL,
      bytes INTEGER NOT NULL, prepared INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS shorts_upload_attempts_time ON shorts_upload_attempts(created);`);
  }

  // Reserve before any session parts or legacy originals are written. Failed
  // attempts remain charged; the shared budget survives process restarts.
  reserve(actor: string, id: string, bytes: number) {
    this.transaction(() => this.charge(actor, id, bytes, false));
  }

  beginPreparation(actor: string, id: string, bytes: number) {
    this.transaction(() => {
      const row = this.store.db
        .prepare('SELECT * FROM shorts_upload_attempts WHERE id=?')
        .get(id);
      if (row && (row.actor !== actor || row.bytes !== bytes))
        throw new Error('Upload reservation mismatch');
      // The first preparation uses the session's reservation. Repeated failed
      // finishes and old sessions consume a fresh attempt before CPU/disk work.
      if (!row || row.prepared || Number(row.created) <= Date.now() - HOUR)
        this.charge(actor, randomUUID(), bytes, true);
      this.store.db
        .prepare('UPDATE shorts_upload_attempts SET prepared=1 WHERE id=?')
        .run(id);
    });
  }

  private charge(actor: string, id: string, bytes: number, prepared: boolean) {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES)
      throw new Error('Choose a video up to 40 MB');
    const now = Date.now();
    this.store.db
      .prepare('DELETE FROM shorts_upload_attempts WHERE created<=?')
      .run(now - 24 * HOUR);
    const own = this.store.db
      .prepare(
        'SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM shorts_upload_attempts WHERE actor=? AND created>?',
      )
      .get(actor, now - HOUR)!;
    const total = this.store.db
      .prepare(
        'SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM shorts_upload_attempts WHERE created>?',
      )
      .get(now - HOUR)!;
    if (Number(own.n) >= 10 || Number(own.bytes) + bytes > 10 * MAX_BYTES)
      throw new HttpException(
        'Limit of 10 upload attempts per hour reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (Number(total.n) >= 100 || Number(total.bytes) + bytes > 100 * MAX_BYTES)
      throw new HttpException(
        'Upload capacity reached. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.store.db
      .prepare('INSERT INTO shorts_upload_attempts VALUES(?,?,?,?,?)')
      .run(id, actor, now, bytes, Number(prepared));
  }

  private transaction(action: () => void) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
}
