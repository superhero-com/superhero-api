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
import { isAbsolute, join } from 'node:path';
import { LOCAL_DIR } from './shorts-chain.service';
import { ShortRecord } from './shorts.types';
import { ShortsSafetyService } from './shorts-safety.service';

const run = promisify(execFile);
@Injectable()
export class ShortsMediaService implements OnModuleInit {
  private key: Buffer;
  private pinnedCids = new Set<string>();
  readonly api = (
    process.env.SHORTS_IPFS_API || 'http://127.0.0.1:35002/api/v0'
  )
    .trim()
    .replace(/\/$/, '');
  constructor(readonly safety: ShortsSafetyService) {}
  async onModuleInit() {
    // Validate storage configuration before accepting uploads.
    await this.ipfsHeaders();
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
  private async ipfsHeaders(): Promise<Headers> {
    if (
      process.env.SHORTS_IPFS_APIS !== undefined ||
      process.env.SHORTS_IPFS_CREDENTIALS_FILE !== undefined
    )
      throw new Error(
        'Replace SHORTS_IPFS_APIS and SHORTS_IPFS_CREDENTIALS_FILE with SHORTS_IPFS_API and SHORTS_IPFS_TOKEN_FILE',
      );
    const url = new URL(this.api);
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (
      this.api.includes(',') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/api/v0' ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          local &&
          process.env.NODE_ENV !== 'production'
        ))
    )
      throw new Error(
        'IPFS requires an explicit HTTPS RPC endpoint (HTTP is local development only)',
      );
    const tokenFile = process.env.SHORTS_IPFS_TOKEN_FILE;
    const headers = new Headers();
    if (!tokenFile) {
      if (!local || process.env.NODE_ENV === 'production')
        throw new Error('IPFS credentials are required for remote storage');
      return headers;
    }
    if (!isAbsolute(tokenFile))
      throw new Error('IPFS token file must use an absolute path');
    // Read the server-only key per request so rotation needs no API restart.
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!/^[0-9a-f]{64}$/.test(token))
      throw new Error('Invalid IPFS service token');
    headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }
  private async ipfsFetch(path: string, init: RequestInit) {
    const headers = await this.ipfsHeaders();
    return fetch(`${this.api}/${path}`, {
      ...init,
      headers,
      // Never send a storage credential to a redirected destination.
      redirect: 'error',
    });
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
  ) {
    const form = new FormData();
    for (const file of files)
      form.append('file', new Blob([new Uint8Array(file.data)]), file.name);
    const response = await this.ipfsFetch(
      `add?wrap-with-directory=true&cid-version=1&pin=${!onlyHash}&only-hash=${onlyHash}`,
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
    if ((await this.add(files, false)) !== short.cid)
      throw new Error('IPFS commitment mismatch');
    for (const f of short.files) await this.retrieve(short, f.name);
    this.pinnedCids.add(short.cid);
  }
  async preview(short: ShortRecord) {
    return this.load(short.id, 'video.mp4');
  }
  async rescan(short: ShortRecord) {
    return this.safety.scan(await this.load(short.id, 'original'));
  }
  async retrieve(short: ShortRecord, name: string) {
    const entry = short.files.find((f) => f.name === name);
    if (!entry) throw new Error('Unknown media file');
    const response = await this.ipfsFetch(
      `cat?arg=${encodeURIComponent(`${short.cid}/${name}`)}`,
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
      const response = await this.ipfsFetch('id', {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async pins(): Promise<Set<string>> {
    const response = await this.ipfsFetch('pin/ls?type=recursive', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Cannot inspect IPFS pins');
    this.pinnedCids = new Set(Object.keys((await response.json()).Keys ?? {}));
    return new Set(this.pinnedCids);
  }
  hasPin(cid: string) {
    return this.pinnedCids.has(cid);
  }
  async unpin(cid: string) {
    if (!this.pinnedCids.has(cid)) return;
    const response = await this.ipfsFetch(
      `pin/rm?arg=${encodeURIComponent(cid)}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error('Cannot remove IPFS pin');
    this.pinnedCids.delete(cid);
  }
}
