import { createHash } from 'node:crypto';
import type { UploadInput } from './shorts-uploads.service';
import type { ShortsStoreService } from './shorts-store.service';
import type { ShortRecord } from './shorts.types';

export const legacyMediaIdentity = (r: ShortRecord) =>
  JSON.stringify([
    r.id,
    r.creator,
    r.cid,
    r.bytes,
    r.duration,
    r.files.map((f) => [f.name, f.bytes, f.sha256]),
    r.createdAt,
  ]);

export type LegacyUpload = UploadInput & {
  id: string;
  actor: string;
  created: number;
  parts: number[];
  complete: boolean;
};
export interface LegacyJob {
  id: string;
  actor: string;
  status: string;
  attempts: number;
  created: number;
  updated: number;
  error?: string;
}
export interface LegacyUploadSnapshot {
  upload: LegacyUpload;
  job?: LegacyJob;
  fingerprint: string;
  expires: number;
}
export const legacyFingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function legacyHasTable(store: ShortsStoreService, name: string) {
  return !!store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}
/** Read while the local store's exclusive ownership fence is held. */
export function legacyUploads(
  store: ShortsStoreService,
): LegacyUploadSnapshot[] {
  const jobs = legacyHasTable(store, 'shorts_ingest_jobs')
    ? store.db.prepare('SELECT * FROM shorts_ingest_jobs ORDER BY id').all()
    : [];
  const rows = legacyHasTable(store, 'shorts_uploads')
    ? store.db.prepare('SELECT * FROM shorts_uploads ORDER BY id').all()
    : [];
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const job of jobs)
    if (
      !byId.has(String(job.id)) &&
      (['queued', 'processing'].includes(String(job.status)) ||
        Number(job.updated) + 86400000 > Date.now())
    )
      throw new Error('A saved local preparation job has no upload record');
  return rows
    .map((row) => {
      const upload: LegacyUpload = JSON.parse(String(row.body));
      if (
        upload.id !== row.id ||
        upload.actor !== row.actor ||
        upload.created !== row.created
      )
        throw new Error('Local upload identity does not match its record');
      const job = jobs.find((job) => job.id === row.id) as unknown as
        LegacyJob | undefined;
      const expires = Number(job?.updated || upload.created) + 86400000;
      return {
        upload,
        job,
        fingerprint: legacyFingerprint({ upload, job }),
        expires,
      };
    })
    .filter(
      (item) =>
        item.expires > Date.now() ||
        ['queued', 'processing'].includes(item.job?.status),
    );
}
