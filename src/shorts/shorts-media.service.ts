import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_DIR } from './shorts-chain.service';
import { ShortRecord } from './shorts.types';
import { ShortsSafetyService } from './shorts-safety.service';

const run = promisify(execFile);
@Injectable()
export class ShortsMediaService implements OnModuleInit {
  private key: Buffer;
  private nodePins: Set<string>[] = [];
  readonly apis = (
    process.env.SHORTS_IPFS_APIS || 'http://127.0.0.1:35002/api/v0'
  )
    .split(',')
    .map((s) => s.trim());
  constructor(readonly safety: ShortsSafetyService) {}
  async onModuleInit() {
    await mkdir(join(LOCAL_DIR, 'private'), { recursive: true, mode: 0o700 });
    try {
      this.key = await readFile(join(LOCAL_DIR, 'quarantine.key'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.key = randomBytes(32);
      await writeFile(join(LOCAL_DIR, 'quarantine.key'), this.key, {
        mode: 0o600,
        flag: 'wx',
      });
    }
  }
  private async store(id: string, name: string, data: Buffer) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(data), cipher.final()]);
    await writeFile(
      join(LOCAL_DIR, 'private', `${id}-${name}.enc`),
      Buffer.concat([iv, cipher.getAuthTag(), bytes]),
      { mode: 0o600 },
    );
  }
  private async load(id: string, name: string) {
    const input = await readFile(
      join(LOCAL_DIR, 'private', `${id}-${name}.enc`),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      input.subarray(0, 12),
    );
    decipher.setAuthTag(input.subarray(12, 28));
    return Buffer.concat([
      decipher.update(input.subarray(28)),
      decipher.final(),
    ]);
  }
  async saveUploadPart(id: string, index: number, bytes: Buffer) {
    await this.store(id, `part-${index}`, bytes);
  }
  async loadUploadPart(id: string, index: number) {
    return this.load(id, `part-${index}`);
  }
  async removeUploadParts(id: string, count: number) {
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        rm(join(LOCAL_DIR, 'private', `${id}-part-${index}.enc`), {
          force: true,
        }),
      ),
    );
  }
  private async add(
    files: { name: string; data: Buffer }[],
    onlyHash: boolean,
    endpoint = this.apis[0],
  ) {
    const form = new FormData();
    for (const file of files)
      form.append('file', new Blob([new Uint8Array(file.data)]), file.name);
    const response = await fetch(
      `${endpoint}/add?wrap-with-directory=true&cid-version=1&pin=${!onlyHash}&only-hash=${onlyHash}`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(60000) },
    );
    if (!response.ok) throw new Error(`IPFS add failed (${response.status})`);
    const rows = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    return rows.at(-1).Hash as string;
  }
  async prepare(
    id: string,
    input: Buffer,
    title: string,
    topic: string,
    details: {
      description?: string;
      language?: string;
      synthetic?: boolean;
      sponsored?: boolean;
      captions?: string;
    } = {},
  ) {
    const temp = await mkdtemp(join(LOCAL_DIR, 'transcode-'));
    try {
      await this.store(id, 'original', input);
      await writeFile(join(temp, 'input'), input, { mode: 0o600 });
      const { stdout } = await run(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          '-protocol_whitelist',
          'file,pipe',
          join(temp, 'input'),
        ],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      const probe = JSON.parse(stdout);
      const stream = probe.streams.find((s: any) => s.codec_type === 'video');
      const duration = Number(probe.format.duration);
      if (
        !stream ||
        !Number.isFinite(duration) ||
        duration < 2 ||
        !String(probe.format.format_name)
          .split(',')
          .some((format) => ['mov', 'mp4'].includes(format)) ||
        duration > 60 ||
        stream.width * stream.height > 3840 * 2160
      )
        throw new Error(
          'Choose an MP4/MOV video between 2 and 60 seconds, up to 4K',
        );
      const safety = await this.safety.scan(input);
      await run(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          join(temp, 'input'),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-t',
          '60',
          '-vf',
          'scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2,setsar=1',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '26',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          '-threads',
          '2',
          join(temp, 'video.mp4'),
        ],
        { timeout: 120000 },
      );
      await run(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-i',
          join(temp, 'video.mp4'),
          '-frames:v',
          '1',
          join(temp, 'poster.jpg'),
        ],
        { timeout: 15000 },
      );
      const files = [
        { name: 'video.mp4', data: await readFile(join(temp, 'video.mp4')) },
        { name: 'poster.jpg', data: await readFile(join(temp, 'poster.jpg')) },
        {
          name: 'manifest.json',
          data: Buffer.from(
            JSON.stringify({
              version: 1,
              title,
              topic,
              duration,
              video: 'video.mp4',
              poster: 'poster.jpg',
              classification: 'creator-declared-local-preview',
              description: details.description || '',
              language: details.language || 'und',
              synthetic: details.synthetic === true,
              sponsored: details.sponsored === true,
              captions: details.captions ? 'captions.vtt' : undefined,
            }),
          ),
        },
      ];
      if (details.captions)
        files.push({
          name: 'captions.vtt',
          data: Buffer.from(details.captions),
        });
      const bytes = files.reduce((n, f) => n + f.data.length, 0);
      if (bytes > 100000000)
        throw new Error('Processed package exceeds 100 MB');
      for (const f of files) await this.store(id, f.name, f.data);
      return {
        safety,
        cid: await this.add(files, true),
        bytes,
        duration,
        files: files.map((f) => ({
          name: f.name,
          bytes: f.data.length,
          sha256: createHash('sha256').update(f.data).digest('hex'),
        })),
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async pin(short: ShortRecord) {
    const files = await Promise.all(
      short.files.map(async (f) => ({
        name: f.name,
        data: await this.load(short.id, f.name),
      })),
    );
    for (const endpoint of this.apis) {
      if ((await this.add(files, false, endpoint)) !== short.cid)
        throw new Error('IPFS commitment mismatch');
      for (const f of short.files)
        await this.retrieveFrom(short, f.name, endpoint);
    }
  }
  async preview(short: ShortRecord) {
    return this.load(short.id, 'video.mp4');
  }
  async rescan(short: ShortRecord) {
    return this.safety.scan(await this.load(short.id, 'original'));
  }
  async retrieve(short: ShortRecord, name: string) {
    for (const endpoint of this.apis) {
      try {
        return await this.retrieveFrom(short, name, endpoint);
      } catch {
        /* Try the other verified replica. */
      }
    }
    throw new Error('Verified IPFS media unavailable on all replicas');
  }
  private async retrieveFrom(
    short: ShortRecord,
    name: string,
    endpoint: string,
  ) {
    const entry = short.files.find((f) => f.name === name);
    if (!entry) throw new Error('Unknown media file');
    const response = await fetch(
      `${endpoint}/cat?arg=${encodeURIComponent(`${short.cid}/${name}`)}`,
      { method: 'POST', signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) throw new Error('IPFS media unavailable');
    const data = Buffer.from(await response.arrayBuffer());
    if (
      data.length !== entry.bytes ||
      createHash('sha256').update(data).digest('hex') !== entry.sha256
    )
      throw new Error('IPFS media integrity check failed');
    return data;
  }
  async health() {
    try {
      const results = await Promise.all(
        this.apis.map((endpoint) =>
          fetch(`${endpoint}/version`, {
            method: 'POST',
            signal: AbortSignal.timeout(3000),
          }),
        ),
      );
      return results.every((r) => r.ok);
    } catch {
      return false;
    }
  }
  async pins(): Promise<Set<string>> {
    this.nodePins = await Promise.all(
      this.apis.map(async (endpoint) => {
        const response = await fetch(`${endpoint}/pin/ls?type=recursive`, {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('Cannot inspect local IPFS pins');
        return new Set(Object.keys((await response.json()).Keys ?? {}));
      }),
    );
    return new Set(this.nodePins.flatMap((pins) => [...pins]));
  }
  hasAllPins(cid: string) {
    return (
      this.nodePins.length === this.apis.length &&
      this.nodePins.every((pins) => pins.has(cid))
    );
  }
  async unpin(cid: string) {
    for (const [index, endpoint] of this.apis.entries()) {
      if (!this.nodePins[index]?.has(cid)) continue;
      const response = await fetch(
        `${endpoint}/pin/rm?arg=${encodeURIComponent(cid)}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error('Cannot remove local IPFS pin');
    }
  }
}
