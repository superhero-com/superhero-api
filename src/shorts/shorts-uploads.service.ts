import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ShortsStoreService } from './shorts-store.service';
import { ShortsService, TOPICS } from './shorts.service';

const PART = 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
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
export class ShortsUploadsService implements OnApplicationBootstrap {
  constructor(
    private readonly store: ShortsStoreService,
    private readonly shorts: ShortsService,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS shorts_uploads (id TEXT PRIMARY KEY, actor TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL)',
    );
  }
  async onApplicationBootstrap() {
    await this.cleanup();
  }
  private async cleanup() {
    const rows = this.store.db
      .prepare('SELECT body FROM shorts_uploads WHERE created<?')
      .all(Date.now() - TTL);
    for (const row of rows) {
      const upload: Upload = JSON.parse(String(row.body));
      await this.shorts.media.removeUploadParts(
        upload.id,
        Math.ceil(upload.bytes / PART),
      );
      this.store.db
        .prepare('DELETE FROM shorts_uploads WHERE id=?')
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
    if (!row) throw new Error('Upload session not found');
    const upload: Upload = JSON.parse(String(row.body));
    if (upload.created + TTL <= Date.now())
      throw new Error('Upload expired. Start a new upload.');
    return upload;
  }
  private status(upload: Upload) {
    return {
      id: upload.id,
      parts: upload.parts,
      partSize: PART,
      expires: upload.created + TTL,
      complete: upload.complete,
    };
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
    const count = this.store.db
      .prepare(
        'SELECT COUNT(*) AS n FROM shorts_uploads WHERE actor=? AND created>?',
      )
      .get(actor, Date.now() - 3600000);
    if (Number(count?.n) >= 10)
      throw new Error('Limit of 10 upload sessions per hour reached');
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
    this.save(upload);
    return this.status(upload);
  }
  get(actor: string, id: string) {
    return this.status(this.own(actor, id));
  }
  async part(actor: string, id: string, index: number, bytes: Buffer) {
    const upload = this.own(actor, id);
    const count = Math.ceil(upload.bytes / PART);
    if (upload.complete) return this.status(upload);
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
  async finish(actor: string, id: string) {
    const upload = this.own(actor, id);
    if (upload.complete) return this.shorts.item(id);
    const count = Math.ceil(upload.bytes / PART);
    if (upload.parts.length !== count) throw new Error('Upload is incomplete');
    const chunks = [];
    for (let i = 0; i < count; i++)
      chunks.push(await this.shorts.media.loadUploadPart(id, i));
    const bytes = Buffer.concat(chunks);
    if (
      bytes.length !== upload.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== upload.sha256
    )
      throw new Error('Upload checksum mismatch. Reselect the original video.');
    const video = await this.shorts.upload(
      actor,
      upload.title,
      upload.topic,
      bytes,
      upload.details,
      id,
    );
    upload.complete = true;
    this.save(upload);
    await this.shorts.media.removeUploadParts(id, count);
    return video;
  }
}
