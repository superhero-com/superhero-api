import { Inject, Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { createDecipheriv, createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { ShortsStoreService } from './shorts-store.service';
import {
  ShortsMetadataService,
  ShortsScope,
  IngestionInput,
} from './shorts-metadata.service';
import { ShortsLegacyImportsService } from './shorts-legacy-imports.service';
import {
  ShortsPrivateObjectsService,
  PrivateObjectRef,
} from './shorts-private-objects.service';
import {
  ShortsUploadRecordsService,
  SHORTS_PART_BYTES,
} from './shorts-upload-records.service';
import { ShortsSourceService } from './shorts-source.service';
import { ShortsPackageService } from './shorts-package.service';
import { ShortRecord, LocalState } from './shorts.types';
import {
  LegacyUploadSnapshot,
  legacyFingerprint,
  legacyHasTable,
  legacyUploads,
  legacyMediaIdentity,
} from './shorts-legacy-snapshot';
import { shortsWorkerConfig } from './shorts-worker.config';
import type { UploadInput } from './shorts-uploads.service';
import { ShortsMeasurementsService } from './shorts-measurements.service';
import { ShortsReceiptsService } from './shorts-receipts.service';
import { legacyAnalytics } from './shorts-analytics-legacy';

export const SHORTS_LEGACY_STORAGE_CONFIG = Symbol(
  'SHORTS_LEGACY_STORAGE_CONFIG',
);
export interface LegacyStorageConfig {
  directory: string;
  scope: ShortsScope;
  sourceHash: string;
  previousContract?: string;
}
export async function legacyStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyStorageConfig> {
  const { scope, sourceHash, release } = await shortsWorkerConfig(env);
  if (!!env.SHORTS_PREVIOUS_DEPLOYMENT_FILE !== !!release.previousContract)
    throw new Error('Mount the predecessor manifest required by this release');
  if (!isAbsolute(env.SHORTS_DATA_DIR || ''))
    throw new Error('Set the existing absolute SHORTS_DATA_DIR');
  const directory = await realpath(env.SHORTS_DATA_DIR);
  if (
    !(await lstat(env.SHORTS_DATA_DIR)).isDirectory() ||
    (await realpath(join(directory, 'private'))) !== join(directory, 'private')
  )
    throw new Error('Legacy storage directories must not be symbolic links');
  const database = await lstat(join(directory, 'shorts.sqlite'));
  if (!database.isFile() || database.size === 0)
    throw new Error('An existing legacy database is required');
  let previousContract: string | undefined;
  if (env.SHORTS_PREVIOUS_DEPLOYMENT_FILE) {
    const previous = await shortsWorkerConfig({
      ...env,
      SHORTS_DEPLOYMENT_FILE: env.SHORTS_PREVIOUS_DEPLOYMENT_FILE,
    });
    if (
      previous.scope.network !== scope.network ||
      previous.scope.contract !== release.previousContract ||
      !release.previousArtifact ||
      (['compiler', 'sourceHash', 'bytecodeHash', 'aciHash'] as const).some(
        (key) => previous.release[key] !== release.previousArtifact[key],
      )
    )
      throw new Error('Invalid previous deployment');
    previousContract = previous.scope.contract;
  }
  return { directory, scope, sourceHash, previousContract };
}
const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

/** Offline, resumable storage transfer. No listener, decoder, IPFS or signing authority. */
@Injectable()
export class ShortsLegacyStorageService {
  private key: Buffer;
  constructor(
    @Inject(SHORTS_LEGACY_STORAGE_CONFIG)
    private readonly config: LegacyStorageConfig,
    private readonly store: ShortsStoreService,
    private readonly metadata: ShortsMetadataService,
    private readonly imports: ShortsLegacyImportsService,
    private readonly objects: ShortsPrivateObjectsService,
    private readonly uploads: ShortsUploadRecordsService,
    private readonly source: ShortsSourceService,
    private readonly packages: ShortsPackageService,
    private readonly measurements: ShortsMeasurementsService,
    private readonly receipts: ShortsReceiptsService,
  ) {}
  private async bytes(path: string, maximum: number, secret = false) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > maximum ||
        (secret && (info.mode & 0o077) !== 0)
      )
        throw new Error('Invalid private legacy file');
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > maximum)
        throw new Error('Legacy file exceeds its size limit');
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  }
  private async read(id: string, name: string, maxBytes: number) {
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !/^(original|video\.mp4|poster\.jpg|manifest\.json|captions\.vtt|part-\d{1,2})$/.test(
        name,
      )
    )
      throw new Error('Invalid legacy media path');
    const bytes = await this.bytes(
      join(this.config.directory, 'private', `${id}-${name}.enc`),
      maxBytes + 28,
    );
    if (bytes.length <= 28) throw new Error('Empty legacy media file');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]);
  }
  private async put(id: string, slot: string, bytes: Buffer) {
    const ref = await this.objects.put(this.config.scope, id, slot, bytes);
    if (!(await this.objects.get(this.config.scope, ref)).equals(bytes))
      throw new Error('Private copy did not verify');
    return ref;
  }
  private uploadInput(snapshot: LegacyUploadSnapshot): UploadInput {
    const u = snapshot.upload;
    const input = {
      title: u.title,
      topic: u.topic,
      rights: u.rights,
      bytes: u.bytes,
      sha256: u.sha256,
      details: u.details,
    };
    this.uploads.validateInput(input);
    if (
      !/^[a-f0-9-]{36}$/.test(u.id) ||
      !/^ak_[a-zA-Z0-9]{1,97}$/.test(u.actor) ||
      !Number.isSafeInteger(u.created) ||
      u.created < 0 ||
      !Number.isSafeInteger(snapshot.expires) ||
      !Array.isArray(u.parts) ||
      new Set(u.parts).size !== u.parts.length ||
      u.parts.some(
        (i) =>
          !Number.isInteger(i) ||
          i < 0 ||
          i >= Math.ceil(u.bytes / SHORTS_PART_BYTES),
      ) ||
      (snapshot.job &&
        (snapshot.job.id !== u.id || snapshot.job.actor !== u.actor))
    )
      throw new Error('Invalid saved legacy upload');
    return input;
  }
  private async manifest(
    id: string,
    creator: string,
    input: UploadInput,
    parts: { index: number; object: PrivateObjectRef }[],
  ) {
    const ref = await this.put(
      id,
      'source-manifest',
      Buffer.from(
        JSON.stringify({
          version: 1,
          id,
          creator,
          bytes: input.bytes,
          sha256: input.sha256,
          parts,
        }),
      ),
    );
    const source: IngestionInput = {
      objectKey: ref.key,
      manifest: ref,
      sha256: input.sha256,
      bytes: input.bytes,
      title: input.title,
      topic: input.topic,
      details: input.details,
    };
    await this.source.read(this.config.scope, { id, creator, input: source });
    return source;
  }
  private async prepared(
    record: ShortRecord,
    snapshot: LegacyUploadSnapshot | undefined,
    apply: boolean,
  ) {
    if (record.privateMedia)
      throw new Error(
        'Local metadata already has shared references; inspect the migration source',
      );
    const files = [] as { name: string; data: Buffer }[];
    for (const file of record.files) {
      if (
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 67108864
      )
        throw new Error('Invalid legacy prepared size');
      const data = await this.read(record.id, file.name, file.bytes);
      if (data.length !== file.bytes || hash(data) !== file.sha256)
        throw new Error('Legacy prepared checksum mismatch');
      files.push({ name: file.name, data });
    }
    if (
      files.reduce((n, f) => n + f.data.length, 0) !== record.bytes ||
      (await this.packages.cid(files)) !== record.cid
    )
      throw new Error(
        'Legacy media package does not match its content identity',
      );
    const original = await this.read(
      record.id,
      'original',
      40 * SHORTS_PART_BYTES,
    );
    const input: UploadInput = snapshot
      ? this.uploadInput(snapshot)
      : {
          title: record.title,
          topic: record.topic,
          rights: true,
          bytes: original.length,
          sha256: hash(original),
          details: {
            description: record.description || '',
            language: record.language || 'und',
            synthetic: record.synthetic === true,
            sponsored: record.sponsored === true,
            captions: files
              .find((file) => file.name === 'captions.vtt')
              ?.data.toString('utf8'),
          },
        };
    if (
      input.bytes !== original.length ||
      input.sha256 !== hash(original) ||
      (record.safety?.sourceSha256 &&
        record.safety.sourceSha256 !== hash(original))
    )
      throw new Error('Legacy original does not match its accepted source');
    if (!apply) return;
    const parts = [] as { index: number; object: PrivateObjectRef }[];
    for (
      let index = 0;
      index < Math.ceil(original.length / SHORTS_PART_BYTES);
      index++
    )
      parts.push({
        index,
        object: await this.put(
          record.id,
          `part/${index}`,
          original.subarray(
            index * SHORTS_PART_BYTES,
            (index + 1) * SHORTS_PART_BYTES,
          ),
        ),
      });
    const source = await this.manifest(record.id, record.creator, input, parts);
    const refs: Record<string, PrivateObjectRef> = {};
    for (const file of files)
      refs[file.name] = await this.put(
        record.id,
        `attempt/0/${file.name.replaceAll('.', '-')}`,
        file.data,
      );
    await this.imports.content(this.config.scope, record, {
      version: 1,
      fence: '0',
      source,
      files: refs,
    });
  }
  private async upload(
    snapshot: LegacyUploadSnapshot,
    ready: boolean,
    apply: boolean,
  ) {
    const input = this.uploadInput(snapshot),
      u = snapshot.upload;
    if ((u.complete && !ready) || (snapshot.job?.status === 'ready' && !ready))
      throw new Error('Completed legacy upload has no content record');
    if (ready) {
      if (!apply) return;
      const record = (await this.metadata.get(this.config.scope, u.id)).record;
      if (
        record.creator !== u.actor ||
        !record.privateMedia ||
        record.privateMedia.source.sha256 !== input.sha256 ||
        record.privateMedia.source.bytes !== input.bytes
      )
        throw new Error('Legacy upload does not match its migrated content');
      const manifest = JSON.parse(
        (
          await this.objects.get(
            this.config.scope,
            record.privateMedia.source.manifest,
          )
        ).toString('utf8'),
      );
      await this.imports.upload(
        this.config.scope,
        snapshot,
        manifest.parts,
        record.privateMedia.source,
        true,
      );
      return;
    }
    const parts = [] as { index: number; object: PrivateObjectRef }[];
    const chunks: Buffer[] = [];
    for (const index of [...u.parts].sort((a, b) => a - b)) {
      const expected = Math.min(
        SHORTS_PART_BYTES,
        u.bytes - index * SHORTS_PART_BYTES,
      );
      const bytes = await this.read(u.id, `part-${index}`, expected);
      if (bytes.length !== expected)
        throw new Error('Legacy upload part length mismatch');
      chunks.push(bytes);
      if (apply)
        parts.push({
          index,
          object: await this.put(u.id, `part/${index}`, bytes),
        });
    }
    if (snapshot.job) {
      if (
        u.parts.length !== Math.ceil(u.bytes / SHORTS_PART_BYTES) ||
        hash(Buffer.concat(chunks)) !== u.sha256
      )
        throw new Error('Saved preparation source is incomplete or corrupt');
    }
    if (apply)
      await this.imports.upload(
        this.config.scope,
        snapshot,
        parts,
        snapshot.job
          ? await this.manifest(u.id, u.actor, input, parts)
          : undefined,
      );
  }
  async run(apply = false) {
    const state: LocalState = this.store.load();
    if (
      !state ||
      state.contract !== this.config.scope.contract ||
      state.sourceHash !== this.config.sourceHash ||
      !Array.isArray(state.shorts)
    )
      throw new Error('Legacy database and deployment manifest do not match');
    this.key = await this.bytes(
      join(this.config.directory, 'quarantine.key'),
      32,
      true,
    );
    if (this.key.length !== 32)
      throw new Error('The original legacy encryption key is required');
    const snapshots = legacyUploads(this.store),
      ready = new Set(state.shorts.map((record) => record.id));
    const analytics = legacyAnalytics(this.store);
    const cutoverHash = createHash('sha256').update(
      JSON.stringify([
        state,
        analytics?.fingerprint,
        this.config.previousContract,
      ]),
    );
    // Bind the complete saved source, including expired rows, so retries do not
    // depend on wall-clock session expiry and a changed source cannot resume.
    for (const table of [
      'shorts_uploads',
      'shorts_ingest_jobs',
      'shorts_upload_attempts',
    ])
      if (legacyHasTable(this.store, table))
        cutoverHash.update(
          JSON.stringify([
            table,
            this.store.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
          ]),
        );
    const fingerprint = cutoverHash.digest('hex');
    // Validate metadata before any durable transfer; the byte checks below remain authoritative.
    for (const snapshot of snapshots) this.uploadInput(snapshot);
    if (apply) {
      await this.metadata.initialize(this.config.scope, this.config.sourceHash);
      await this.imports.cutover(this.config.scope, fingerprint);
      await this.metadata.importLegacy(
        this.config.scope,
        state.shorts,
        legacyFingerprint(state.shorts),
        true,
      );
      const attempts = legacyHasTable(this.store, 'shorts_upload_attempts')
        ? this.store.db
            .prepare('SELECT * FROM shorts_upload_attempts ORDER BY id')
            .all()
        : [];
      // Older snapshots may predate admission tracking. Reserve at least the
      // original upload attempt; never give an imported live session a free reset.
      for (const { upload } of snapshots)
        if (!attempts.some((attempt) => attempt.id === upload.id))
          attempts.push({
            id: upload.id,
            actor: upload.actor,
            created: upload.created,
            bytes: upload.bytes,
            prepared: 0,
          });
      for (const attempt of attempts)
        await this.imports.budget(this.config.scope, attempt as any);
    }
    let copied = 0,
      resumed = 0;
    for (const record of state.shorts) {
      if (
        apply &&
        (await this.imports.completed(
          this.config.scope,
          'content',
          record.id,
          legacyFingerprint(record),
        ))
      ) {
        const current = (await this.metadata.get(this.config.scope, record.id))
          .record;
        if (
          !current.privateMedia ||
          legacyMediaIdentity(current) !== legacyMediaIdentity(record)
        )
          throw new Error('Migrated content lost its private references');
        await this.source.read(this.config.scope, {
          id: current.id,
          creator: current.creator,
          input: current.privateMedia.source,
        });
        for (const file of current.files) {
          const ref = current.privateMedia.files[file.name];
          if (!ref || ref.sha256 !== file.sha256 || ref.bytes !== file.bytes)
            throw new Error('Migrated file reference mismatch');
          await this.objects.get(this.config.scope, ref);
        }
        resumed++;
        continue;
      }
      await this.prepared(
        record,
        snapshots.find((item) => item.upload.id === record.id),
        apply,
      );
      copied++;
    }
    for (const snapshot of snapshots) {
      if (
        apply &&
        (await this.imports.completed(
          this.config.scope,
          'upload',
          snapshot.upload.id,
          snapshot.fingerprint,
        ))
      ) {
        const shared = await this.uploads.get(
          this.config.scope,
          snapshot.upload.id,
          snapshot.upload.actor,
        );
        for (const part of shared.parts)
          await this.objects.get(this.config.scope, part.object);
        resumed++;
        continue;
      }
      await this.upload(snapshot, ready.has(snapshot.upload.id), apply);
      copied++;
    }
    if (apply) {
      await this.measurements.initialize(
        this.config.scope,
        this.config.sourceHash,
        analytics,
        true,
      );
      await this.receipts.initialize(
        this.config.scope,
        this.config.sourceHash,
        this.config.previousContract,
        state.receipts || [],
        true,
      );
      await this.imports.cutover(this.config.scope, fingerprint, true);
    }
    return {
      mode: apply ? 'applied' : 'checked',
      videos: state.shorts.length,
      uploads: snapshots.length,
      processed: copied,
      resumed,
    };
  }
}
