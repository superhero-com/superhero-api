/**
 * Backfill `posts.language` for rows the detector never ran on (legacy posts
 * inserted before the column existed, left `null`).
 *
 * Run against a built tree:
 *   npm run backfill:post-language -- [--dry-run] [--batch-size=500] \
 *     [--sleep-ms=250] [--max-batches=N]
 *
 * Safety properties (see ZIX contract):
 *   - Only touches rows where `language IS NULL`; an already-set value is never
 *     overwritten. The UPDATE re-checks `p.language IS NULL` so a row tagged by
 *     the live insert path between the SELECT and the UPDATE is left alone.
 *   - Pages forward on the primary key in bounded batches; no transaction spans
 *     more than one batch.
 *   - Sleeps between batches so normal traffic is not starved.
 *   - Resumable/idempotent: stop and re-run at any time — `language IS NULL`
 *     tracks progress across runs, `lastId` within a run. A dry run makes no
 *     writes but still pages on `lastId` so it finishes.
 *   - Uses the migration DataSource only; it never boots AppModule (which would
 *     schedule a second PostService.sync() against the live database).
 */
import type { DataSource } from 'typeorm';
import AppDataSource from '../../data-source';
import { detectPostLanguage, PostLanguage } from '../utils/post-language.util';

export interface BackfillOptions {
  dryRun: boolean;
  batchSize: number;
  sleepMs: number;
  maxBatches: number;
}

export interface BackfillResult {
  batches: number;
  selected: number;
  updated: number;
  counts: Record<PostLanguage, number>;
}

/** Minimal surface the backfill needs, so tests can supply a fake. */
type QueryExecutor = Pick<DataSource, 'query'>;

const DEFAULT_BATCH_SIZE = 500;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 5000;
const DEFAULT_SLEEP_MS = 250;

export function parseBackfillOptions(argv: string[]): BackfillOptions {
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  let sleepMs = DEFAULT_SLEEP_MS;
  let maxBatches = Number.POSITIVE_INFINITY;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const rawValue = eq === -1 ? '' : arg.slice(eq + 1);
    switch (key) {
      case '--batch-size':
        batchSize = Number(rawValue);
        break;
      case '--sleep-ms':
        sleepMs = Number(rawValue);
        break;
      case '--max-batches':
        maxBatches = Number(rawValue);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (
    !Number.isInteger(batchSize) ||
    batchSize < MIN_BATCH_SIZE ||
    batchSize > MAX_BATCH_SIZE
  ) {
    throw new Error(
      `--batch-size must be an integer in [${MIN_BATCH_SIZE}, ${MAX_BATCH_SIZE}]`,
    );
  }
  if (!Number.isFinite(sleepMs) || sleepMs < 0) {
    throw new Error(`--sleep-ms must be a non-negative number`);
  }
  if (
    maxBatches !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(maxBatches) || maxBatches < 1)
  ) {
    throw new Error(`--max-batches must be a positive integer`);
  }

  return { dryRun, batchSize, sleepMs, maxBatches };
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

/**
 * Core backfill loop, decoupled from process.argv and the app DataSource so it
 * can be driven by a fake executor in tests.
 */
export async function backfillPostLanguage(
  db: QueryExecutor,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const totals = emptyTally();
  let lastId = '';
  let batchNumber = 0;
  let totalSelected = 0;
  let totalUpdated = 0;

  while (batchNumber < options.maxBatches) {
    const batchStartedAt = Date.now();
    const rows: Array<{ id: string; content: string | null }> = await db.query(
      `SELECT id, content FROM posts
         WHERE language IS NULL AND id > $1
         ORDER BY id ASC
         LIMIT $2`,
      [lastId, options.batchSize],
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

    let updated = 0;
    if (!options.dryRun) {
      // Single statement per batch; the `p.language IS NULL` guard keeps a row
      // tagged by the live insert path in the meantime from being overwritten.
      // RETURNING makes the count reliable across driver result shapes.
      const result = await db.query(
        `UPDATE posts p
           SET language = v.language
           FROM (VALUES ${values.join(', ')}) AS v(id, language)
           WHERE p.id = v.id AND p.language IS NULL
           RETURNING p.id`,
        params,
      );
      updated = affectedRowCount(result);
    }
    totalUpdated += updated;

    lastId = rows[rows.length - 1].id;
    const elapsedMs = Date.now() - batchStartedAt;
    console.log(
      `[backfill:post-language] batch ${batchNumber}: selected=${rows.length} ` +
        `updated=${options.dryRun ? '(dry-run)' : updated} ` +
        `counts=${JSON.stringify(perLanguage)} lastId=${lastId} elapsedMs=${elapsedMs}`,
    );

    // Stop before sleeping when this was the last (short) page.
    if (rows.length < options.batchSize) {
      break;
    }
    if (options.sleepMs > 0) {
      await sleep(options.sleepMs);
    }
  }

  return {
    batches: batchNumber,
    selected: totalSelected,
    updated: totalUpdated,
    counts: totals,
  };
}

async function main(): Promise<void> {
  const options = parseBackfillOptions(process.argv.slice(2));
  const startedAt = Date.now();

  console.log(
    `[backfill:post-language] starting (dryRun=${options.dryRun}, batchSize=${options.batchSize}, sleepMs=${options.sleepMs}, maxBatches=${options.maxBatches})`,
  );

  await AppDataSource.initialize();
  try {
    const result = await backfillPostLanguage(AppDataSource, options);
    const totalElapsedMs = Date.now() - startedAt;
    console.log(
      `[backfill:post-language] done (dryRun=${options.dryRun}): batches=${result.batches} ` +
        `selected=${result.selected} updated=${options.dryRun ? '(dry-run)' : result.updated} ` +
        `counts=${JSON.stringify(result.counts)} elapsedMs=${totalElapsedMs}`,
    );
  } finally {
    await AppDataSource.destroy();
  }
}

// Only run when invoked directly (dist/social/scripts/backfill-post-language.js),
// so importing the module in a test does not touch the database.
if (require.main === module) {
  main().catch((error) => {
    console.error('[backfill:post-language] failed:', error);
    process.exitCode = 1;
  });
}
