import { ShortsDatabaseService } from './shorts-database.service';
import { Inject, ConflictException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { IngestionInput, ShortsScope } from './shorts-metadata.service';
import type { ShortRecord } from './shorts.types';
import type { PrivateObjectRef } from './shorts-private-objects.service';
import {
  LegacyUploadSnapshot,
  legacyFingerprint,
  legacyMediaIdentity,
} from './shorts-legacy-snapshot';

/** Trusted offline migration authority. Never provided to a media-worker login. */
@Injectable()
export class ShortsLegacyImportsService {
  constructor(@Inject(ShortsDatabaseService) private readonly db: DataSource) {}

  async cutover(scope: ShortsScope, fingerprint: string, complete = false) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new Error('Invalid legacy cutover identity');
    await this.db.transaction(async (db) => {
      await db.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
      );
      const [runtime] = await db.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        [scope.network, scope.contract],
      );
      if (!runtime) throw new Error('Initialize the legacy deployment first');
      await db.query(
        `INSERT INTO shorts_legacy_cutovers(network,contract,fingerprint)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [scope.network, scope.contract, fingerprint],
      );
      const [current] = await db.query(
        'SELECT fingerprint FROM shorts_legacy_cutovers WHERE network=$1 AND contract=$2',
        [scope.network, scope.contract],
      );
      if (current.fingerprint !== fingerprint)
        throw new ConflictException(
          'The legacy snapshot changed during cutover',
        );
      if (complete)
        await db.query(
          `UPDATE shorts_legacy_cutovers SET completed_at=coalesce(completed_at,clock_timestamp())
        WHERE network=$1 AND contract=$2`,
          [scope.network, scope.contract],
        );
    });
  }
  async completed(
    scope: ShortsScope,
    kind: string,
    id: string,
    fingerprint: string,
    db: EntityManager | DataSource = this.db,
  ) {
    const [row] = await db.query(
      'SELECT fingerprint FROM shorts_storage_imports WHERE network=$1 AND contract=$2 AND kind=$3 AND id=$4',
      [scope.network, scope.contract, kind, id],
    );
    if (row && row.fingerprint !== fingerprint)
      throw new ConflictException('The legacy source changed after migration');
    return !!row;
  }
  private async transaction(
    scope: ShortsScope,
    kind: string,
    id: string,
    fingerprint: string,
    operation: (db: EntityManager) => Promise<void>,
  ) {
    await this.db.transaction(async (db) => {
      const [runtime] = await db.query(
        'SELECT contract FROM shorts_runtime WHERE network=$1 AND contract=$2 FOR UPDATE',
        [scope.network, scope.contract],
      );
      if (!runtime)
        throw new Error('Initialize the shared deployment before migrating');
      if (await this.completed(scope, kind, id, fingerprint, db)) return;
      await operation(db);
      await db.query(
        'INSERT INTO shorts_storage_imports(network,contract,kind,id,fingerprint) VALUES($1,$2,$3,$4,$5)',
        [scope.network, scope.contract, kind, id, fingerprint],
      );
    });
  }
  async content(
    scope: ShortsScope,
    source: ShortRecord,
    refs: NonNullable<ShortRecord['privateMedia']>,
  ) {
    await this.transaction(
      scope,
      'content',
      source.id,
      legacyFingerprint(source),
      async (db) => {
        const [current] = await db.query(
          'SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3 FOR UPDATE',
          [scope.network, scope.contract, source.id],
        );
        if (!current)
          throw new ConflictException(
            'Import legacy content metadata before its private files',
          );
        if (
          legacyMediaIdentity(current.body) !== legacyMediaIdentity(source) ||
          current.body.privateMedia
        )
          throw new ConflictException(
            'Shared content identity already differs from the legacy media',
          );
        // Attach only storage references; never restore old review, report or publication state.
        await db.query(
          `UPDATE shorts_content SET body=jsonb_set(body,'{privateMedia}',$4::jsonb),revision=revision+1
        WHERE network=$1 AND contract=$2 AND id=$3`,
          [scope.network, scope.contract, source.id, JSON.stringify(refs)],
        );
      },
    );
  }
  async budget(
    scope: ShortsScope,
    attempt: {
      id: string;
      actor: string;
      created: number;
      bytes: number;
      prepared: number;
    },
  ) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(attempt.id) ||
      !/^ak_[a-zA-Z0-9]{1,97}$/.test(attempt.actor) ||
      !Number.isSafeInteger(attempt.created) ||
      attempt.created < 0 ||
      !Number.isSafeInteger(attempt.bytes) ||
      attempt.bytes < 1 ||
      attempt.bytes > 41943040
    )
      throw new Error('Invalid legacy upload budget');
    await this.transaction(
      scope,
      'budget',
      attempt.id,
      legacyFingerprint(attempt),
      async (db) => {
        await db.query(
          `INSERT INTO shorts_upload_admission(network,contract,upload_id,creator,bytes,created_at)
        VALUES($1,$2,$3,$4,$5,to_timestamp($6::double precision/1000))`,
          [
            scope.network,
            scope.contract,
            attempt.id,
            attempt.actor,
            attempt.bytes,
            attempt.created,
          ],
        );
      },
    );
  }
  async upload(
    scope: ShortsScope,
    snapshot: LegacyUploadSnapshot,
    parts: { index: number; object: PrivateObjectRef }[],
    input?: IngestionInput,
    ready = false,
  ) {
    const { upload, job } = snapshot;
    await this.transaction(
      scope,
      'upload',
      upload.id,
      snapshot.fingerprint,
      async (db) => {
        const accepted = !!job || ready;
        const details = {
          title: upload.title,
          topic: upload.topic,
          rights: upload.rights,
          bytes: upload.bytes,
          sha256: upload.sha256,
          details: upload.details,
        };
        await db.query(
          `INSERT INTO shorts_upload_sessions(network,contract,id,creator,input,state,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,to_timestamp($7::double precision/1000),to_timestamp($8::double precision/1000))`,
          [
            scope.network,
            scope.contract,
            upload.id,
            upload.actor,
            JSON.stringify(details),
            accepted ? 'enqueued' : 'uploading',
            upload.created,
            snapshot.expires,
          ],
        );
        for (const part of parts)
          await db.query(
            'INSERT INTO shorts_upload_parts(network,contract,upload_id,part,object_ref) VALUES($1,$2,$3,$4,$5::jsonb)',
            [
              scope.network,
              scope.contract,
              upload.id,
              part.index,
              JSON.stringify(part.object),
            ],
          );
        if (accepted) {
          if (
            !input ||
            (job &&
              (!['queued', 'processing', 'failed', 'ready'].includes(
                job.status,
              ) ||
                !Number.isInteger(job.attempts) ||
                job.attempts < 0 ||
                job.attempts > 3))
          )
            throw new Error('Invalid saved preparation job');
          const attempts = job?.attempts || 0;
          const status = ready
            ? 'ready'
            : job?.status === 'failed' || attempts >= 3
              ? 'failed'
              : 'queued';
          await db.query(
            `INSERT INTO shorts_ingestion(network,contract,id,creator,input,status,attempts,created_at,updated_at,error_code,result_id)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,to_timestamp($8::double precision/1000),to_timestamp($9::double precision/1000),$10,$11)`,
            [
              scope.network,
              scope.contract,
              upload.id,
              upload.actor,
              JSON.stringify(input),
              status,
              attempts,
              job?.created || upload.created,
              job?.updated || upload.created,
              status === 'failed'
                ? attempts >= 3
                  ? 'attempts_exhausted'
                  : 'preparation_failed'
                : null,
              ready ? upload.id : null,
            ],
          );
        }
      },
    );
  }
}
