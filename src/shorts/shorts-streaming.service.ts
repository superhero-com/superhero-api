import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ShortsStoreService } from './shorts-store.service';

// Durable publication outbox: playback preparation must survive an unavailable
// worker/Redis or an API restart. No video bytes pass through this integration.
@Injectable()
export class ShortsStreamingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShortsStreamingService.name);
  private readonly endpoint = process.env.SHORTS_STREAM_INTERNAL_URL?.replace(
    /\/$/,
    '',
  );
  private readonly keyFile = process.env.SHORTS_STREAM_KEY_FILE;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private readonly shutdown = new AbortController();
  constructor(private readonly store: ShortsStoreService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS shorts_stream_outbox (
      id TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)`);
    if (this.endpoint) {
      const url = new URL(this.endpoint);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' &&
          !(
            local &&
            url.protocol === 'http:' &&
            process.env.NODE_ENV !== 'production'
          ))
      )
        throw new Error(
          'SHORTS_STREAM_INTERNAL_URL requires an HTTPS origin (HTTP only for local development)',
        );
      if (!this.keyFile || !isAbsolute(this.keyFile))
        throw new Error(
          'SHORTS_STREAM_KEY_FILE must be an absolute server-only key path',
        );
    }
  }
  enqueue(id: string) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid Short ID');
    this.store.db
      .prepare('INSERT OR IGNORE INTO shorts_stream_outbox(id) VALUES(?)')
      .run(id);
  }
  onApplicationBootstrap() {
    for (const short of this.store.load()?.shorts || [])
      if (short.publication === 'published') this.enqueue(short.id);
    if (!this.endpoint) return;
    this.timer = setInterval(() => {
      void this.dispatch();
    }, 15000);
    this.timer.unref();
    void this.dispatch();
  }
  async dispatch() {
    if (this.running || this.stopped || !this.endpoint) return;
    this.running = true;
    try {
      const rows = this.store.db
        .prepare(
          'SELECT id, attempts FROM shorts_stream_outbox WHERE ready=0 AND next_at<=? ORDER BY next_at LIMIT 20',
        )
        .all(Date.now());
      for (const row of rows) {
        if (this.stopped) break;
        try {
          const key = (await readFile(this.keyFile!, 'utf8')).trim();
          if (!/^[a-f0-9]{64}$/.test(key))
            throw new Error('Invalid streaming key');
          const response = await fetch(
            `${this.endpoint}/internal/videos/${encodeURIComponent(String(row.id))}/prepare`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}` },
              redirect: 'error',
              signal: AbortSignal.any([
                this.shutdown.signal,
                AbortSignal.timeout(10000),
              ]),
            },
          );
          await response.body?.cancel();
          if (this.stopped) break;
          if (![200, 202].includes(response.status))
            throw new Error('Preparation unavailable');
          this.store.db
            .prepare(
              'UPDATE shorts_stream_outbox SET ready=?, attempts=0, next_at=? WHERE id=?',
            )
            .run(response.status === 200 ? 1 : 0, Date.now() + 15000, row.id);
        } catch {
          if (this.stopped) break;
          const attempts = Math.min(Number(row.attempts) + 1, 16);
          this.store.db
            .prepare(
              'UPDATE shorts_stream_outbox SET attempts=?, next_at=? WHERE id=?',
            )
            .run(
              attempts,
              Date.now() + Math.min(300000, 1000 * 2 ** attempts),
              row.id,
            );
          this.logger.warn(`Video preparation will retry: ${row.id}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
  onModuleDestroy() {
    this.stopped = true;
    this.shutdown.abort();
    if (this.timer) clearInterval(this.timer);
  }
}
