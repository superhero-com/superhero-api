import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { request as httpRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { TextDecoder } from 'node:util';
import {
  PinInventoryConfig,
  SHORTS_PIN_INVENTORY_CONFIG,
} from './shorts-pin-inventory.config';

export type PinType = 'recursive' | 'direct';
export interface PinObservation {
  cid: string;
  type: PinType;
}
export function pinCid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,118})$/.test(value)
  );
}
function json(data: Buffer) {
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(data));
}

/** Bounded, backpressured metadata reads. No redirects, media reads, retries or mutating RPCs. */
@Injectable()
export class ShortsPinReaderService implements OnModuleDestroy {
  private readonly stop = new AbortController();
  constructor(
    @Inject(SHORTS_PIN_INVENTORY_CONFIG)
    private readonly config: PinInventoryConfig,
  ) {}

  private async response(
    path: string,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.config.api}/${path}`);
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: 'POST',
          agent: false,
          signal,
          maxHeaderSize: 8192,
          ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            'Accept-Encoding': 'identity',
          },
        },
      );
      const deadline = setTimeout(
        () => req.destroy(new Error('IPFS response deadline')),
        5000,
      );
      req.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      req.once('response', (res) => {
        clearTimeout(deadline);
        res.setTimeout(5000, () =>
          res.destroy(new Error('IPFS read deadline')),
        );
        // An aborted response can precede an async iterator starting to consume it.
        res.on('error', () => {});
        if (res.statusCode !== 200 || res.headers['content-encoding']) {
          res.destroy();
          reject(new Error('IPFS inventory response rejected'));
          return;
        }
        resolve(res);
      });
      req.end();
    });
  }
  private signal(signal?: AbortSignal, timeout = 10000) {
    return AbortSignal.any([
      this.stop.signal,
      AbortSignal.timeout(timeout),
      ...(signal ? [signal] : []),
    ]);
  }
  private complete(res: IncomingMessage) {
    if (
      !res.complete ||
      [...Object.keys(res.trailers), ...Object.keys(res.headers)].some((key) =>
        /stream-error/i.test(key),
      )
    )
      throw new Error('Incomplete IPFS inventory response');
  }
  private async small(path: string, signal?: AbortSignal) {
    const abort = this.signal(signal),
      res = await this.response(path, abort);
    let data = Buffer.alloc(0);
    try {
      for await (const chunk of res) {
        abort.throwIfAborted();
        if (data.length + chunk.length > 16384)
          throw new Error('IPFS metadata size exceeded');
        data = Buffer.concat([data, chunk]);
      }
      abort.throwIfAborted();
      this.complete(res);
      return json(data);
    } finally {
      res.destroy();
    }
  }
  async identity(signal?: AbortSignal) {
    const value = await this.small('id', signal);
    if (value?.ID !== this.config.peerId)
      throw new Error('IPFS node identity changed');
    return value.ID as string;
  }
  async capacity(signal?: AbortSignal) {
    const value = await this.small(
      'repo/stat?size-only=true&human=false',
      signal,
    );
    // Kubo 0.43.1 flattens SizeStat in its JSON encoder. Reject unsafe JS integers.
    if (
      !Number.isSafeInteger(value?.RepoSize) ||
      value.RepoSize < 0 ||
      !Number.isSafeInteger(value?.StorageMax) ||
      value.StorageMax < 1
    )
      throw new Error('Invalid IPFS capacity observation');
    return {
      repoBytes: String(value.RepoSize),
      storageMaxBytes: String(value.StorageMax),
    };
  }
  async *pins(
    type: PinType,
    signal?: AbortSignal,
  ): AsyncGenerator<PinObservation[]> {
    if (!['recursive', 'direct'].includes(type))
      throw new Error('Invalid pin type');
    const abort = this.signal(signal, 120000);
    const res = await this.response(
      `pin/ls?type=${type}&stream=true&names=false`,
      abort,
    );
    let pending = Buffer.alloc(0),
      bytes = 0,
      count = 0,
      page: PinObservation[] = [];
    try {
      for await (const chunk of res) {
        abort.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024)
          throw new Error('IPFS pin response size exceeded');
        pending = Buffer.concat([pending, chunk]);
        let end: number;
        while ((end = pending.indexOf(10)) !== -1) {
          if (end < 1 || end > 512 || ++count > 100000)
            throw new Error('IPFS pin stream limit exceeded');
          const value = json(pending.subarray(0, end));
          pending = pending.subarray(end + 1);
          if (
            !pinCid(value?.Cid) ||
            value.Type !== type ||
            Object.keys(value).some((key) => !['Cid', 'Type'].includes(key))
          )
            throw new Error('Invalid IPFS pin observation');
          page.push({ cid: value.Cid, type });
          if (page.length === 50) {
            yield page;
            page = [];
            abort.throwIfAborted();
          }
        }
        if (pending.length > 512)
          throw new Error('IPFS pin line size exceeded');
      }
      abort.throwIfAborted();
      this.complete(res);
      if (pending.length) throw new Error('Truncated IPFS pin line');
      if (page.length) yield page;
    } finally {
      res.destroy();
    }
  }
  onModuleDestroy() {
    this.stop.abort();
  }
}
