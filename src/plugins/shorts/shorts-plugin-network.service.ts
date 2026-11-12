import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { ShortsChainService } from '@/shorts/shorts-chain.service';
import {
  readShortsJson,
  discardShortsResponse,
} from '@/shorts/shorts-upstream';

/** The shared indexer and Shorts must use the same reviewed network endpoints. */
@Injectable()
export class ShortsPluginNetworkService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly shutdown = new AbortController();
  private pending?: Promise<void>;
  private verifiedUntil = 0;
  private active = 0;
  private identity = '';

  constructor(
    private readonly chain: ShortsChainService,
    private readonly config: ConfigService,
    private readonly ae: AeSdkService,
  ) {}

  bindings() {
    this.shutdown.signal.throwIfAborted();
    const release = this.chain.release;
    if (
      !release ||
      process.env.AE_NETWORK_ID !== release.network ||
      this.config.get<string>('mdw.middlewareUrl') !== release.middleware ||
      this.ae.sdk.api.$host.replace(/\/$/, '') !== release.node ||
      this.chain.sdk.api.$host.replace(/\/$/, '') !== release.node
    )
      throw new Error(
        'Shorts release does not match the shared indexer network',
      );
    return release;
  }

  async onApplicationBootstrap() {
    await this.verify();
  }
  onModuleDestroy() {
    this.shutdown.abort();
    this.verifiedUntil = 0;
  }

  /** Coalesce concurrent checks; only successful same-binding proof lives for 5s. */
  async verify() {
    const release = this.bindings();
    const identity = JSON.stringify([
      release.network,
      release.node,
      release.middleware,
      release.contract,
    ]);
    if (identity !== this.identity) {
      this.verifiedUntil = 0;
      this.identity = identity;
    }
    if (performance.now() < this.verifiedUntil) return;
    if (this.pending) return this.pending;
    this.pending = this.check()
      .then(() => {
        const current = this.bindings();
        if (
          JSON.stringify([
            current.network,
            current.node,
            current.middleware,
            current.contract,
          ]) !== identity
        )
          throw new Error('Shorts indexer release changed during verification');
        this.verifiedUntil = performance.now() + 5000;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async check() {
    const release = this.bindings();
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(20000),
    ]);
    const status = await this.chain.readNode(
      () => this.chain.sdk.api.getStatus(),
      signal,
    );
    if (status.networkId !== release.network)
      throw new Error('Shorts indexer node is on another network');
    const mdw = await this.json(`${release.middleware}/v3/status`, signal);
    const height = Math.min(status.topBlockHeight, mdw.mdw_height) - 2;
    if (
      !Number.isSafeInteger(status.topBlockHeight) ||
      !Number.isSafeInteger(mdw.mdw_height) ||
      !Number.isSafeInteger(height) ||
      height < 0
    )
      throw new Error('Shorts indexer network checkpoint is unavailable');
    const [nodeBlock, middlewareBlock] = await Promise.all([
      this.chain.readNode(
        () => this.chain.sdk.api.getKeyBlockByHeight(height),
        signal,
      ),
      this.json(`${release.middleware}/v3/key-blocks/${height}`, signal),
    ]);
    if (
      nodeBlock.height !== height ||
      middlewareBlock.height !== height ||
      !nodeBlock.hash ||
      nodeBlock.hash !== middlewareBlock.hash
    )
      throw new Error('Shorts middleware disagrees with the verified node');
    signal.throwIfAborted();
  }

  async json(value: string, parent?: AbortSignal, timeoutMs = 10000) {
    const release = this.bindings();
    const base = new URL(release.middleware);
    if (typeof value !== 'string' || value.length > 8192)
      throw new Error('Invalid Shorts middleware URL');
    const url = new URL(value);
    const prefix = `${base.pathname.replace(/\/$/, '')}/v3/`;
    const path = url.pathname.slice(prefix.length);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith(prefix) ||
      !/^(status|key-blocks\/[0-9]+|contracts\/logs|transactions\/th_[1-9A-HJ-NP-Za-km-z]+)$/.test(
        path,
      )
    )
      throw new Error('Shorts middleware request outside its authority');
    if (![10000, 60000].includes(timeoutMs))
      throw new Error('Invalid middleware read deadline');
    if (this.active >= 8)
      throw new Error('Shorts middleware requests are busy');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(timeoutMs),
      ...(parent ? [parent] : []),
    ]);
    this.active++;
    try {
      signal.throwIfAborted();
      const response = await fetch(url, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        discardShortsResponse(response);
        throw new Error(`Shorts middleware HTTP ${response.status}`);
      }
      const body = await readShortsJson(response, 1048576, signal);
      this.bindings();
      return body;
    } finally {
      this.active--;
    }
  }

  generation(height: number) {
    this.bindings();
    return this.chain.readNode(
      () => this.chain.sdk.api.getGenerationByHeight(height),
      this.shutdown.signal,
    );
  }
}
