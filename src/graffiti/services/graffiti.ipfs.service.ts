import { Injectable } from '@nestjs/common';
import { create, IPFSHTTPClient } from 'ipfs-http-client';

@Injectable()
export class GraffitiIpfsService {
  private client: IPFSHTTPClient;

  constructor() {
    if (!process.env.IPFS_URL) throw new Error('IPFS_URL is not set');
    this.client = create({ url: process.env.IPFS_URL });
  }

  async addAndPin(buffer: Buffer) {
    const added = await this.client.add({ content: buffer });
    // Pin non-blocking
    void this.client.pin.add(added.path).catch(() => undefined);
    return added;
  }

  async getFile(hash: string): Promise<Buffer> {
    // quick stat check with timeout similar to original implementation
    const stat = await Promise.race<any>([
      this.client.files.stat(`/ipfs/${hash}`),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (!stat) throw new Error('IPFS: not found');
    const chunks = [] as Buffer[];
    for await (const chunk of this.client.cat(hash)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async checkFileExists(hash: string): Promise<boolean> {
    const stat = await Promise.race<any>([
      this.client.files.stat(`/ipfs/${hash}`),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    return !!stat && String(stat.cid) === hash;
  }

  async id(): Promise<any> {
    return this.client.id();
  }
}
