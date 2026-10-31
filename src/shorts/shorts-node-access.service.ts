import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Node } from '@aeternity/aepp-sdk';
import { createHttpHeaders, HttpClient } from '@azure/core-rest-pipeline';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setMaxListeners } from 'node:events';
import { readShortsResponse } from './shorts-upstream';

/** Read-operation cancellation reaches SDK requests even when the SDK drops call options. */
@Injectable()
export class ShortsNodeAccessService implements OnModuleDestroy {
  private readonly context = new AsyncLocalStorage<AbortSignal>();
  private readonly shutdown = new AbortController();
  private activeRequests = 0;
  private activeReads = 0;
  constructor() {
    // Both operation and request admission are bounded below.
    setMaxListeners(64, this.shutdown.signal);
  }

  createNode(origin: string, allowSubmission = false) {
    const node = new Node(origin, {
      retryCount: 0,
      httpClient: this.transport(origin, allowSubmission),
    });
    // The SDK combines GETs without considering cancellation. One cancelled
    // creator request must not cancel a different creator's request.
    node.pipeline.removePolicy({ name: 'combine-get-requests' });
    return node;
  }

  async read<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
    timeoutMs = 20000,
  ): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 20000)
      throw new Error('Invalid node read deadline');
    if (this.activeReads >= 32)
      throw new ServiceUnavailableException('Shorts node reads are busy');
    const controller = new AbortController();
    setMaxListeners(64, controller.signal);
    this.activeReads++;
    const abort = () =>
      controller.abort(
        new ServiceUnavailableException(
          'Shorts node read cancelled or timed out',
        ),
      );
    const parents = [
      this.shutdown.signal,
      this.context.getStore(),
      signal,
    ].filter((s): s is AbortSignal => !!s);
    parents.forEach((s) => {
      s.addEventListener('abort', abort, { once: true });
      if (s.aborted) abort();
    });
    const timer = setTimeout(abort, timeoutMs);
    let rejectAbort: (() => void) | undefined;
    try {
      controller.signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, {
          once: true,
        });
      });
      // Read-only operations may be abandoned at the SDK promise boundary. Their
      // context is aborted too: subsequent SDK requests cannot start. Never use
      // this boundary around database mutations or transaction submissions.
      return await this.context.run(controller.signal, () =>
        Promise.race([operation(), cancelled]),
      );
    } finally {
      clearTimeout(timer);
      if (rejectAbort)
        controller.signal.removeEventListener('abort', rejectAbort);
      parents.forEach((s) => s.removeEventListener('abort', abort));
      controller.abort();
      this.activeReads--;
    }
  }

  transport(
    origin: string,
    allowSubmission = false,
    timeoutMs = 8000,
  ): HttpClient {
    if (allowSubmission && process.env.NODE_ENV === 'production')
      throw new Error('Local node submission is unavailable in production');
    const configured = new URL(origin);
    if (
      configured.origin !== origin ||
      configured.username ||
      configured.password ||
      (configured.protocol !== 'https:' &&
        !(
          configured.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname) &&
          process.env.NODE_ENV !== 'production'
        )) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 10 ||
      timeoutMs > 8000
    )
      throw new Error('Invalid Shorts node transport configuration');
    return {
      sendRequest: async (request) => {
        const url = new URL(request.url);
        if (
          url.origin !== origin ||
          url.username ||
          url.password ||
          url.hash ||
          !url.pathname.startsWith('/v3/') ||
          !['GET', 'POST'].includes(request.method) ||
          (request.method === 'POST' &&
            url.pathname !== '/v3/dry-run' &&
            !(allowSubmission && url.pathname === '/v3/transactions'))
        )
          throw new Error('Shorts node request outside its authority');
        if (
          request.body != null &&
          (typeof request.body !== 'string' ||
            Buffer.byteLength(request.body) > 131072)
        )
          throw new Error('Shorts node request is too large');
        if (this.activeRequests >= 16)
          throw new ServiceUnavailableException(
            'Shorts node requests are busy',
          );
        const controller = new AbortController();
        const abort = () =>
          controller.abort(
            new ServiceUnavailableException(
              'Shorts node request cancelled or timed out',
            ),
          );
        const parents = [
          this.shutdown.signal,
          this.context.getStore(),
          request.abortSignal,
        ].filter((s) => !!s);
        parents.forEach((s) => {
          s!.addEventListener('abort', abort);
          if (s!.aborted) abort();
        });
        const timer = setTimeout(abort, timeoutMs);
        this.activeRequests++;
        try {
          controller.signal.throwIfAborted();
          const response = await fetch(url, {
            method: request.method,
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: request.body as string | undefined,
            signal: controller.signal,
            redirect: 'error',
          });
          const bytes = await readShortsResponse(
            response,
            5242880,
            controller.signal,
          );
          const bodyAsText = new TextDecoder('utf-8', { fatal: true }).decode(
            bytes,
          );
          if (response.ok && url.pathname === '/v3/dry-run') {
            // The SDK's detached handler assumes one result per transaction:
            // missing rows never settle, and excess rows throw out of band.
            // Reject at the awaited transport boundary instead.
            const input = JSON.parse(request.body as string);
            const output = JSON.parse(bodyAsText);
            if (
              !Array.isArray(input?.txs) ||
              !Array.isArray(output?.results) ||
              output.results.length !== input.txs.length ||
              output.results.some(
                (row: unknown) => !row || typeof row !== 'object',
              )
            )
              throw new Error('Invalid Shorts node dry-run results');
          }
          return {
            request,
            status: response.status,
            headers: createHttpHeaders(Object.fromEntries(response.headers)),
            bodyAsText,
          };
        } finally {
          clearTimeout(timer);
          parents.forEach((s) => s!.removeEventListener('abort', abort));
          controller.abort();
          this.activeRequests--;
        }
      },
    };
  }

  onModuleDestroy() {
    this.shutdown.abort();
  }
}
