import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { detectPostLanguage, PostLanguage } from '../utils/post-language.util';

/**
 * Runs the `posts.language` backfill automatically once per boot, so legacy
 * rows left `null` before the column existed get tagged without any manual
 * invocation.
 *
 * Production-safety, mirroring the DEX bootstrap/sync services:
 *   - Deferred, not on the boot critical path: it starts on a `setTimeout`
 *     after the app is serving, so it never delays module init or starves the
 *     first requests.
 *   - Only touches rows where `language IS NULL`; an already-set value is never
 *     overwritten (the UPDATE re-checks `language IS NULL`, so a row tagged by
 *     the live insert path in the meantime is left alone).
 *   - Pages forward on the primary key in bounded batches and sleeps between
 *     them, so normal traffic is not starved.
 *   - Single-runner across instances: a non-blocking Postgres advisory lock is
 *     held for the whole run on a dedicated connection, so in a rolling deploy
 *     or multi-pod setup exactly one instance backfills and the rest skip.
 *   - Resumable/idempotent: `language IS NULL` tracks progress, so a re-boot
 *     after an interruption simply continues, and once every row is tagged the
 *     run is a single cheap SELECT that returns nothing.
 */
@Injectable()
export class PostLanguageBackfillService implements OnModuleInit {
  private readonly logger = new Logger(PostLanguageBackfillService.name);

  // Delay the start so migrations, PostService.sync (10s) and the analytics
  // pull (20s) settle first and the backfill never contends with boot traffic.
  private static readonly START_DELAY_MS = 30_000;

  // Stable, unique key; distinct from the DEX advisory locks (…746 / …747).
  private static readonly ADVISORY_LOCK_KEY = 4019283748;

  // Conservative, bounded defaults so the auto-run never bloats the server.
  private static readonly BATCH_SIZE = 500;
  private static readonly SLEEP_MS = 250;

  private running = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (this.isDisabled()) {
      this.logger.log(
        'Automatic post-language backfill disabled (live MDW sync off); skipping.',
      );
      return;
    }
    setTimeout(() => {
      void this.runBackfill();
    }, PostLanguageBackfillService.START_DELAY_MS);
  }

  /**
   * Skipped when the app boots with live MDW sync turned off — a dedicated
   * backfill/maintenance boot that drives its own work. The DEX price sync
   * guards on the same pre-existing flag.
   */
  private isDisabled(): boolean {
    return process.env.DISABLE_MDW_SYNC === 'true';
  }

  async runBackfill(): Promise<void> {
    if (this.isDisabled()) {
      return;
    }
    if (this.running) {
      this.logger.warn('Post-language backfill already running; skipping.');
      return;
    }
    this.running = true;

    // Hold the advisory lock on its own session for the whole run; the backfill
    // queries themselves go through the pool. Session-scoped locks are global
    // across connections, so holding it anywhere blocks other instances.
    const lockRunner = this.dataSource.createQueryRunner();
    let locked = false;
    try {
      await lockRunner.connect();
      const rows: Array<{ locked: boolean }> = await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [PostLanguageBackfillService.ADVISORY_LOCK_KEY],
      );
      locked = rows[0]?.locked === true;
      if (!locked) {
        this.logger.log(
          'Another instance holds the post-language backfill lock; skipping.',
        );
        return;
      }

      const startedAt = Date.now();
      const result = await this.backfill();
      this.logger.log(
        `Automatic post-language backfill done: batches=${result.batches} ` +
          `selected=${result.selected} updated=${result.updated} ` +
          `counts=${JSON.stringify(result.counts)} elapsedMs=${
            Date.now() - startedAt
          }.`,
      );
    } catch (error) {
      // Never let a backfill failure take down the API; it retries next boot.
      this.logger.error(
        'Automatic post-language backfill failed; will retry on next boot.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      try {
        if (locked) {
          await lockRunner.query('SELECT pg_advisory_unlock($1)', [
            PostLanguageBackfillService.ADVISORY_LOCK_KEY,
          ]);
        }
      } finally {
        await lockRunner.release();
        this.running = false;
      }
    }
  }

  /**
   * Null-only, keyset-paged backfill loop. Kept internal to the service so
   * there is a single detector path and no standalone script to invoke.
   */
  private async backfill(): Promise<{
    batches: number;
    selected: number;
    updated: number;
    counts: Record<PostLanguage, number>;
  }> {
    const totals = emptyTally();
    let lastId = '';
    let batchNumber = 0;
    let totalSelected = 0;
    let totalUpdated = 0;

    for (;;) {
      const rows: Array<{ id: string; content: string | null }> =
        await this.dataSource.query(
          `SELECT id, content FROM posts
             WHERE language IS NULL AND id > $1
             ORDER BY id ASC
             LIMIT $2`,
          [lastId, PostLanguageBackfillService.BATCH_SIZE],
        );

      if (rows.length === 0) {
        break;
      }

      batchNumber += 1;
      totalSelected += rows.length;

      const perLanguage = emptyTally();
      const values: string[] = [];
      const params: string[] = [];
      rows.forEach((row, index) => {
        const language = detectPostLanguage(row.content);
        perLanguage[language] += 1;
        totals[language] += 1;
        const idParam = index * 2 + 1;
        const langParam = index * 2 + 2;
        // Cast the first row's params so Postgres infers the VALUES types.
        values.push(
          index === 0
            ? `($${idParam}::varchar, $${langParam}::varchar)`
            : `($${idParam}, $${langParam})`,
        );
        params.push(row.id, language);
      });

      // Single statement per batch; the `p.language IS NULL` guard keeps a row
      // tagged by the live insert path in the meantime from being overwritten.
      const result = await this.dataSource.query(
        `UPDATE posts p
           SET language = v.language
           FROM (VALUES ${values.join(', ')}) AS v(id, language)
           WHERE p.id = v.id AND p.language IS NULL
           RETURNING p.id`,
        params,
      );
      const updated = affectedRowCount(result);
      totalUpdated += updated;

      lastId = rows[rows.length - 1].id;
      this.logger.log(
        `[post-language backfill] batch ${batchNumber}: selected=${rows.length} ` +
          `updated=${updated} counts=${JSON.stringify(perLanguage)} lastId=${lastId}`,
      );

      // Stop before sleeping when this was the last (short) page.
      if (rows.length < PostLanguageBackfillService.BATCH_SIZE) {
        break;
      }
      await sleep(PostLanguageBackfillService.SLEEP_MS);
    }

    return {
      batches: batchNumber,
      selected: totalSelected,
      updated: totalUpdated,
      counts: totals,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyTally(): Record<PostLanguage, number> {
  return { en: 0, zh: 0, ar: 0, ru: 0, und: 0 };
}

/**
 * TypeORM's postgres `query()` returns a structured `[rows, affectedCount]`
 * tuple for a RETURNING statement, so a naive `result.length` is always 2.
 * Read the affected count from the tuple, falling back to the row array length
 * for drivers that return the rows directly.
 */
function affectedRowCount(result: unknown): number {
  if (Array.isArray(result)) {
    if (typeof result[1] === 'number' && Array.isArray(result[0])) {
      return result[1];
    }
    return result.length;
  }
  return 0;
}
