import {
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ShortsStoreService } from './shorts-store.service';
import { ShortsService, TOPICS } from './shorts.service';
import { ShortsUploadLimitsService } from './shorts-upload-limits.service';
import { creatorContent } from './shorts-eligibility';
import { ShortsRecordsService } from './shorts-records.service';

const PART = 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
type JobState = 'queued' | 'processing' | 'ready' | 'failed';
export interface UploadInput {
  title: string;
  topic: string;
  rights: boolean;
  bytes: number;
  sha256: string;
  details: {
    description?: string;
    language?: string;
    synthetic?: boolean;
    sponsored?: boolean;
    captions?: string;
  };
}
interface Upload extends UploadInput {
  id: string;
  actor: string;
  created: number;
  parts: number[];
  complete: boolean;
}
@Injectable()
export class ShortsUploadsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  readonly shared: boolean = false;
  private readonly logger = new Logger(ShortsUploadsService.name);
  private readonly capacity = Number(
    process.env.SHORTS_INGEST_QUEUE_CAPACITY ?? 8,
  );
  private timer?: NodeJS.Timeout;
  private worker?: Promise<void>;
  private stopped = false;
  private readonly records: ShortsRecordsService;
  constructor(
    private readonly store: ShortsStoreService,
    private readonly shorts: ShortsService,
    private readonly limits: ShortsUploadLimitsService,
  ) {
    this.records = shorts.records || new ShortsRecordsService(shorts.chain);
    if (this.records.shared)
      throw new ServiceUnavailableException(
        'Hosted uploads require the shared upload service',
      );
    if (
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 32
    )
      throw new Error(
        'SHORTS_INGEST_QUEUE_CAPACITY must be an integer between 1 and 32',
      );
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS shorts_uploads (id TEXT PRIMARY KEY, actor TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL)',
    );
    store.db.exec(`CREATE TABLE IF NOT EXISTS shorts_ingest_jobs (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
      updated INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS shorts_ingest_status ON shorts_ingest_jobs(status, created);`);
  }
  async onApplicationBootstrap() {
    await this.shorts.media.removeOrphanedPrepared(
      new Set((await this.records.all()).map((short) => short.id)),
    );
    await this.cleanup();
    // Exclusive store ownership has already been acquired. Only this process
    // may recover interrupted jobs; there are no expiring worker leases.
    this.store.db
      .prepare(
        "UPDATE shorts_ingest_jobs SET status='queued',updated=? WHERE status='processing'",
      )
      .run(Date.now());
    this.timer = setInterval(() => {
      void this.drain();
    }, 1000);
    this.timer.unref();
    void this.drain();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.worker;
  }
  private async cleanup() {
    const rows = this.store.db
      .prepare(
        `SELECT body FROM shorts_uploads WHERE created<? AND id NOT IN
        (SELECT id FROM shorts_ingest_jobs WHERE status IN ('queued','processing') OR updated>=?)`,
      )
      .all(Date.now() - TTL, Date.now() - TTL);
    for (const row of rows) {
      const upload: Upload = JSON.parse(String(row.body));
      await this.shorts.media.removeUploadParts(
        upload.id,
        Math.ceil(upload.bytes / PART),
      );
      this.store.db
        .prepare('DELETE FROM shorts_uploads WHERE id=?')
        .run(upload.id);
      this.store.db
        .prepare('DELETE FROM shorts_ingest_jobs WHERE id=?')
        .run(upload.id);
    }
  }
  private save(upload: Upload) {
    this.store.db
      .prepare(
        'INSERT INTO shorts_uploads VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(upload.id, upload.actor, upload.created, JSON.stringify(upload));
  }
  private own(actor: string, id: string): Upload {
    const row = this.store.db
      .prepare('SELECT body FROM shorts_uploads WHERE id=? AND actor=?')
      .get(id, actor);
    if (!row) throw new NotFoundException('Upload session not found');
    const upload: Upload = JSON.parse(String(row.body));
    const job = this.job(id);
    if (
      Number(job?.updated || upload.created) + TTL <= Date.now() &&
      !['queued', 'processing'].includes(String(job?.status))
    )
      throw new GoneException('Upload expired. Start a new upload.');
    return upload;
  }
  private async status(upload: Upload) {
    const job = this.job(upload.id);
    const status = (upload.complete ? 'ready' : job?.status || 'uploading') as
      JobState | 'uploading';
    const video =
      status === 'ready' ? await this.records.get(upload.id) : undefined;
    return {
      id: upload.id,
      parts: upload.parts,
      partSize: PART,
      expires: Number(job?.updated || upload.created) + TTL,
      complete: upload.complete,
      status,
      error: job?.error || undefined,
      attempts: Number(job?.attempts || 0),
      video: video
        ? creatorContent(video, this.shorts.demoAutoApprove)
        : undefined,
    };
  }
  private job(id: string) {
    return this.store.db
      .prepare('SELECT * FROM shorts_ingest_jobs WHERE id=?')
      .get(id);
  }
  async create(actor: string, input: UploadInput) {
    await this.cleanup();
    if (
      !input ||
      input.rights !== true ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 100 ||
      !TOPICS.slice(1).includes(input.topic) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > 40 * PART ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !input.details ||
      typeof input.details !== 'object' ||
      Array.isArray(input.details) ||
      ['description', 'language', 'captions'].some(
        (key) =>
          input.details[key] !== undefined &&
          typeof input.details[key] !== 'string',
      ) ||
      ['synthetic', 'sponsored'].some(
        (key) =>
          input.details[key] !== undefined &&
          typeof input.details[key] !== 'boolean',
      ) ||
      JSON.stringify(input.details).length > 12000
    )
      throw new Error('Invalid upload metadata');
    const global = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM shorts_uploads')
      .get();
    if (Number(global?.n) >= 100)
      throw new Error('Local upload capacity reached');
    const upload: Upload = {
      ...input,
      id: randomUUID(),
      actor,
      created: Date.now(),
      parts: [],
      complete: false,
    };
    this.limits.reserve(actor, upload.id, input.bytes);
    this.save(upload);
    return this.status(upload);
  }
  async get(actor: string, id: string) {
    return this.status(this.own(actor, id));
  }
  prepareDirect: (
    actor: string,
    id: string,
    index: number,
    sha256: string,
  ) => Promise<unknown> = async () => {
    throw new ServiceUnavailableException(
      'Direct uploads require hosted storage',
    );
  };
  authorizeDirect: (
    actor: string,
    id: string,
    index: number,
    checksum: string,
  ) => Promise<unknown> = async () => {
    throw new ServiceUnavailableException(
      'Direct uploads require hosted storage',
    );
  };
  completeDirect: (
    actor: string,
    id: string,
    index: number,
  ) => Promise<unknown> = async () => {
    throw new ServiceUnavailableException(
      'Direct uploads require hosted storage',
    );
  };
  async part(
    actor: string,
    id: string,
    index: number,
    bytes: Buffer,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const upload = this.own(actor, id);
    const count = Math.ceil(upload.bytes / PART);
    if (upload.complete) return this.status(upload);
    if (['queued', 'processing'].includes(String(this.job(id)?.status)))
      throw new ConflictException(
        'This upload is being prepared. Its parts cannot change.',
      );
    const size = index === count - 1 ? upload.bytes - index * PART : PART;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      !bytes ||
      bytes.length !== size
    )
      throw new Error('Invalid upload part size or position');
    await this.shorts.media.saveUploadPart(id, index, bytes);
    if (!upload.parts.includes(index)) upload.parts.push(index);
    this.save(upload);
    return this.status(upload);
  }
  async finish(actor: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.stopped)
      throw new ServiceUnavailableException(
        'Shorts is restarting. Please try again shortly.',
      );
    // Fetch local records before reading admission counters. There must be
    // no await between the idempotency/capacity checks and the SQLite commit.
    const recordCount = (await this.records.all()).length;
    signal?.throwIfAborted();
    const upload = this.own(actor, id);
    if (
      upload.complete ||
      ['queued', 'processing', 'ready'].includes(String(this.job(id)?.status))
    )
      return this.status(upload);
    const count = Math.ceil(upload.bytes / PART);
    if (upload.parts.length !== count) throw new Error('Upload is incomplete');
    if (Number(this.job(id)?.attempts || 0) >= MAX_ATTEMPTS)
      throw new ConflictException(
        'Preparation could not finish after three attempts. Start a new upload.',
      );
    const pending = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM shorts_ingest_jobs WHERE status IN ('queued','processing')",
      )
      .get()!;
    const own = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM shorts_ingest_jobs WHERE actor=? AND status IN ('queued','processing')",
      )
      .get(actor)!;
    if (Number(pending.n) >= this.capacity || Number(own.n) >= 2)
      throw new ServiceUnavailableException(
        'Video preparation is busy. Your upload is saved; please try again shortly.',
      );
    if (recordCount + Number(pending.n) >= 50)
      throw new ServiceUnavailableException(
        'Video capacity reached. Your upload is saved.',
      );
    // Synchronous SQLite commit precedes HTTP 202. Duplicate finish requests
    // return this same job without charging or preparing again.
    const now = Date.now();
    this.store.db
      .prepare(
        `INSERT INTO shorts_ingest_jobs(id,actor,status,created,updated) VALUES(?,?,'queued',?,?)
      ON CONFLICT(id) DO UPDATE SET status='queued',updated=excluded.updated,error=NULL`,
      )
      .run(id, actor, now, now);
    return this.status(upload);
  }

  /** Legacy multipart uploads enter the same persistent preparation queue. */
  async enqueueFile(
    actor: string,
    input: Omit<UploadInput, 'bytes' | 'sha256'>,
    bytes: Buffer,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(bytes)) throw new Error('Choose a video');
    const session = await this.create(actor, {
      ...input,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    for (let index = 0; index < Math.ceil(bytes.length / PART); index++)
      await this.part(
        actor,
        session.id,
        index,
        bytes.subarray(index * PART, (index + 1) * PART),
        signal,
      );
    return this.finish(actor, session.id, signal);
  }

  /** Operator-only aggregate health, with no creator identifiers or media paths. */
  health() {
    const rows = this.store.db
      .prepare(
        'SELECT status,COUNT(*) AS n,MIN(updated) AS oldest FROM shorts_ingest_jobs GROUP BY status',
      )
      .all();
    const counts = Object.fromEntries(
      rows.map((row) => [row.status, Number(row.n)]),
    );
    const queued = rows.find((row) => row.status === 'queued');
    return {
      capacity: this.capacity,
      queued: counts.queued || 0,
      processing: counts.processing || 0,
      failed: counts.failed || 0,
      ready: counts.ready || 0,
      oldestQueuedMs: queued
        ? Math.max(0, Date.now() - Number(queued.oldest))
        : 0,
      workerRunning: !!this.worker,
      stopping: this.stopped,
    };
  }

  drain() {
    if (this.stopped) return Promise.resolve();
    if (this.worker) return this.worker;
    this.worker = this.processQueue()
      .catch(() => {
        this.logger.error(
          'Video preparation queue is unavailable; saved jobs remain pending.',
        );
      })
      .finally(() => {
        this.worker = undefined;
      });
    return this.worker;
  }
  private async processQueue() {
    while (!this.stopped) {
      const job = this.store.db
        .prepare(
          "SELECT * FROM shorts_ingest_jobs WHERE status='queued' ORDER BY updated,id LIMIT 1",
        )
        .get();
      if (!job) return;
      const id = String(job.id);
      const row = this.store.db
        .prepare('SELECT body FROM shorts_uploads WHERE id=?')
        .get(id);
      if (!row) {
        this.fail(id, 'The saved upload is missing. Start a new upload.');
        continue;
      }
      const upload: Upload = JSON.parse(String(row.body));
      const registered = await this.records.find(id);
      if (registered) {
        if (registered.creator !== upload.actor) {
          this.fail(id, 'Upload identity mismatch. Start a new upload.');
          continue;
        }
        await this.complete(upload);
        continue;
      }
      if (Number(job.attempts) >= MAX_ATTEMPTS) {
        this.fail(
          id,
          'Preparation was interrupted too many times. Start a new upload.',
        );
        continue;
      }
      this.store.db
        .prepare(
          "UPDATE shorts_ingest_jobs SET status='processing',attempts=attempts+1,updated=? WHERE id=?",
        )
        .run(Date.now(), id);
      try {
        await this.prepare(upload);
        await this.complete(upload);
      } catch {
        // Detailed decoder/provider errors may contain paths or private input.
        // Explicit retries consume the persistent preparation budget again.
        this.fail(
          id,
          'We could not prepare this video. Check the file and try again.',
        );
      }
    }
  }
  private fail(id: string, message: string) {
    this.store.db
      .prepare(
        "UPDATE shorts_ingest_jobs SET status='failed',updated=?,error=? WHERE id=?",
      )
      .run(Date.now(), message, id);
  }
  private async complete(upload: Upload) {
    upload.complete = true;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(upload);
      this.store.db
        .prepare(
          "UPDATE shorts_ingest_jobs SET status='ready',updated=?,error=NULL WHERE id=?",
        )
        .run(Date.now(), upload.id);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
    // A failed cleanup must not change a saved successful job into a failed one.
    await this.shorts.media
      .removeUploadParts(upload.id, Math.ceil(upload.bytes / PART))
      .catch(() => {
        this.logger.warn(
          'Prepared upload parts will be removed by expiry cleanup.',
        );
      });
  }
  private async prepare(upload: Upload) {
    const count = Math.ceil(upload.bytes / PART);
    const chunks = [];
    for (let i = 0; i < count; i++)
      chunks.push(await this.shorts.media.loadUploadPart(upload.id, i));
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== upload.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== upload.sha256
    )
      throw new Error('Upload checksum mismatch. Reselect the original video.');
    await this.shorts.upload(
      upload.actor,
      upload.title,
      upload.topic,
      bytes,
      upload.details,
      upload.id,
    );
  }
}
