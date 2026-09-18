import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  backfillPostLanguage,
  parseBackfillOptions,
  BackfillOptions,
} from '../scripts/backfill-post-language';

/**
 * Runs the `posts.language` backfill automatically once per boot, so legacy
 * rows left `null` before the column existed get tagged without an operator
 * having to invoke `npm run backfill:post-language` by hand.
 *
 * Production-safety, mirroring the DEX bootstrap/sync services:
 *   - Deferred, not on the boot critical path: it starts on a `setTimeout`
 *     after the app is serving, so it never delays module init or starves the
 *     first requests. The heavy work reuses the standalone script's loop, which
 *     is null-only, keyset-paged in bounded batches, and sleeps between them.
 *   - Single-runner across instances: a non-blocking Postgres advisory lock is
 *     held for the whole run on a dedicated connection, so in a rolling deploy
 *     or multi-pod setup exactly one instance backfills and the rest skip.
 *   - Resumable/idempotent: `language IS NULL` tracks progress, so a re-boot
 *     after an interruption simply continues, and once every row is tagged the
 *     run is a single cheap SELECT that returns nothing.
 *   - Opt-out and tunable via env, defaulting to conservative bounds. The
 *     manual/dry-run path (`npm run backfill:post-language -- --dry-run`) stays
 *     available for operational inspection.
 */
@Injectable()
export class PostLanguageBackfillService implements OnModuleInit {
  private readonly logger = new Logger(PostLanguageBackfillService.name);

  // Delay the start so migrations, PostService.sync (10s) and the analytics
  // pull (20s) settle first and the backfill never contends with boot traffic.
  private static readonly START_DELAY_MS = 30_000;

  // Stable, unique key; distinct from the DEX advisory locks (…746 / …747).
  private static readonly ADVISORY_LOCK_KEY = 4019283748;

  private running = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    if (this.isDisabled()) {
      this.logger.log(
        'Automatic post-language backfill disabled by env; skipping.',
      );
      return;
    }
    setTimeout(() => {
      void this.runBackfill();
    }, PostLanguageBackfillService.START_DELAY_MS);
  }

  /**
   * Disabled by an explicit opt-out kill switch, or when the app boots with the
   * live MDW sync turned off (a dedicated backfill/maintenance boot that drives
   * its own work — the DEX price sync guards on the same flag).
   */
  private isDisabled(): boolean {
    return (
      process.env.POST_LANGUAGE_BACKFILL_DISABLED === 'true' ||
      process.env.DISABLE_MDW_SYNC === 'true'
    );
  }

  /**
   * Conservative auto-run defaults, overridable by env and validated by the
   * same parser the CLI uses. A bad env value is logged and falls back to the
   * defaults rather than crashing boot. Never a dry run — the auto-run exists to
   * actually fill the column; `--dry-run` stays a manual-only path.
   */
  private resolveOptions(): BackfillOptions {
    const argv: string[] = [];
    const batchSize = process.env.POST_LANGUAGE_BACKFILL_BATCH_SIZE;
    const sleepMs = process.env.POST_LANGUAGE_BACKFILL_SLEEP_MS;
    const maxBatches = process.env.POST_LANGUAGE_BACKFILL_MAX_BATCHES;
    if (batchSize) argv.push(`--batch-size=${batchSize}`);
    if (sleepMs) argv.push(`--sleep-ms=${sleepMs}`);
    if (maxBatches) argv.push(`--max-batches=${maxBatches}`);
    try {
      return parseBackfillOptions(argv);
    } catch (error) {
      this.logger.warn(
        `Invalid post-language backfill env override (${
          error instanceof Error ? error.message : String(error)
        }); using defaults.`,
      );
      return parseBackfillOptions([]);
    }
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

      const options = this.resolveOptions();
      this.logger.log(
        `Starting automatic post-language backfill (batchSize=${options.batchSize}, sleepMs=${options.sleepMs}, maxBatches=${options.maxBatches}).`,
      );
      const startedAt = Date.now();
      const result = await backfillPostLanguage(this.dataSource, options);
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
}
