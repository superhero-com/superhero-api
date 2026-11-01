import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  imageCid,
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
  profileMediaSecret,
} from './profile-media.config';

export interface ProfileImageFile {
  name: string;
  bytes: number;
  sha256: string;
}
export const profileImageHash = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
const blockCid = (value: unknown): value is string =>
  typeof value === 'string' && /^baf[yk][a-z2-7]{55}$/.test(value);

@Injectable()
export class ProfileMediaStorage {
  constructor(
    @Inject(PROFILE_MEDIA_CONFIG) private readonly config: ProfileMediaConfig,
  ) {}
  private async request(path: string, body?: FormData, allowError = false) {
    const token = await profileMediaSecret(this.config.ipfsTokenFile);
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new ServiceUnavailableException('Image storage is unavailable');
    try {
      const response = await fetch(`${this.config.ipfs}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok && !allowError) {
        await response.body?.cancel();
        throw new Error();
      }
      return response;
    } catch {
      throw new ServiceUnavailableException(
        'Image storage is busy or unavailable. Try again shortly.',
      );
    }
  }
  private async bounded(response: Response, max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (!reader)
      throw new ServiceUnavailableException('Image storage returned no data');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > max) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch {
      throw new ServiceUnavailableException('Invalid image storage response');
    } finally {
      reader.releaseLock();
    }
  }
  prepare(files: { name: string; data: Buffer }[]) {
    return this.add(files, true);
  }
  pin(files: { name: string; data: Buffer }[]) {
    return this.add(files, false);
  }
  private async add(
    files: { name: string; data: Buffer }[],
    onlyHash: boolean,
  ) {
    const form = new FormData();
    for (const file of files)
      form.append('file', new Blob([new Uint8Array(file.data)]), file.name);
    const response = await this.request(
      `add?wrap-with-directory=true&cid-version=1&raw-leaves=true&chunker=size-262144&pin=${!onlyHash}&only-hash=${onlyHash}`,
      form,
    );
    const data = await this.bounded(response, 16384);
    try {
      const rows = data
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const cid = rows.at(-1)?.Hash;
      if (rows.length !== files.length + 1 || !imageCid(cid)) throw new Error();
      return {
        cid: cid as string,
        files: files.map((file) => ({
          name: file.name,
          bytes: file.data.length,
          sha256: profileImageHash(file.data),
        })),
      };
    } catch {
      throw new ServiceUnavailableException('Invalid image storage commitment');
    }
  }
  async read(cid: string, file: ProfileImageFile) {
    if (
      !imageCid(cid) ||
      !['image.webp', 'thumb.webp', 'manifest.json'].includes(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 3 * 1024 * 1024
    )
      throw new ServiceUnavailableException('Invalid image reference');
    const response = await this.request(
      `cat?arg=${encodeURIComponent(`${cid}/${file.name}`)}`,
    );
    const bytes = await this.bounded(response, file.bytes);
    if (bytes.length !== file.bytes || profileImageHash(bytes) !== file.sha256)
      throw new ServiceUnavailableException(
        'Image integrity verification failed',
      );
    return bytes;
  }

  async blocks(cid: string): Promise<string[]> {
    if (!imageCid(cid)) throw new Error('Invalid image cleanup root');
    const response = await this.request(
      `refs?arg=${cid}&recursive=true&unique=true`,
    );
    const lines = (await this.bounded(response, 16384))
      .toString()
      .trim()
      .split('\n');
    const blocks = new Set<string>();
    for (const line of lines) {
      if (!line) continue;
      const item = JSON.parse(line);
      if (item.Err || !blockCid(item.Ref))
        throw new Error('Incomplete image block inventory');
      blocks.add(item.Ref);
    }
    if (!blocks.size || blocks.size > 63)
      throw new Error('Invalid image block inventory');
    blocks.delete(cid);
    return [...blocks, cid];
  }

  async remove(cid: string, blocks: string[]) {
    if (
      !imageCid(cid) ||
      !Array.isArray(blocks) ||
      !blocks.length ||
      blocks.length > 64 ||
      blocks.at(-1) !== cid ||
      !blocks.every(blockCid) ||
      new Set(blocks).size !== blocks.length
    )
      throw new Error('Invalid image deletion journal');
    const unpin = await this.request(`pin/rm?arg=${cid}`, undefined, true);
    const result = JSON.parse((await this.bounded(unpin, 4096)).toString());
    if (
      !(unpin.ok && result.Pins?.length === 1 && result.Pins[0] === cid) &&
      !(
        unpin.status === 500 &&
        result.Code === 0 &&
        result.Message === 'not pinned or pinned indirectly'
      )
    )
      throw new Error('Image pin removal was not acknowledged');
    for (const block of blocks) {
      const response = await this.request(
        `block/rm?arg=${block}&force=false&quiet=false`,
      );
      const item = JSON.parse((await this.bounded(response, 4096)).toString());
      if (item.Hash !== block)
        throw new Error('Image block removal was not acknowledged');
      // Shared blocks remain pinned by their other image/video roots. The Kubo
      // block remover holds its GC lock while checking pins and removing bytes.
      if (
        item.Error &&
        item.Error !== `ipld: could not find ${block}` &&
        !/^(pinned: (recursive|direct|internal)|pinned via (baf[yk][a-z2-7]{55}|Qm[1-9A-HJ-NP-Za-km-z]{44}))$/.test(
          item.Error,
        )
      )
        throw new Error('Image block removal could not complete');
      if (
        block === cid &&
        item.Error &&
        !item.Error.startsWith('ipld: could not find ')
      )
        throw new Error('Image root is still referenced');
    }
  }
}
