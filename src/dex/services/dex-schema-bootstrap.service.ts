import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Ensures DEX schema additions that post-date the original tables exist in
 * every environment — including production, where TypeORM `synchronize` is
 * disabled (see src/configs/database.ts) and would otherwise never create the
 * new `dex_tokens.listed` column or the performance indexes the DEX endpoints
 * rely on.
 *
 * Every statement is idempotent (`IF NOT EXISTS`). The whole run is serialised
 * across application instances with a Postgres advisory lock so that concurrent
 * boots (rolling deploys, multiple pods) don't race or deadlock on the same
 * DDL. Required statements (the `listed` column) fail fast — the rest of the
 * module hard-depends on the column, so it is better to crash the boot than to
 * serve 500s on every `/dex/tokens` query. Index creation is best-effort:
 * indexes are performance, not correctness, so a failure is logged and boot
 * continues.
 *
 * This is a deliberate stop-gap until the project adopts real TypeORM
 * migrations. Note: index builds use a plain `CREATE INDEX` and therefore take
 * a brief write lock on the target table; on a very large `pair_transactions`
 * table a one-time migration with `CREATE INDEX CONCURRENTLY` is preferable.
 */
@Injectable()
export class DexSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(DexSchemaBootstrapService.name);

  // Arbitrary, stable key so every instance contends on the same advisory lock.
  private static readonly ADVISORY_LOCK_KEY = 4019283746;

  // Correctness-critical: the module reads/writes this column, so a failure
  // here must abort startup rather than be swallowed.
  static readonly REQUIRED_STATEMENTS: readonly string[] = [
    `ALTER TABLE "dex_tokens" ADD COLUMN IF NOT EXISTS "listed" boolean NOT NULL DEFAULT false`,
  ];

  // Performance-only. The pair-history index name MUST match the @Index
  // decorator on PairTransaction so synchronize-based environments and this
  // bootstrap converge on a single index instead of two with different names.
  static readonly INDEX_STATEMENTS: readonly string[] = [
    `CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_pair_created_at" ON "pair_transactions" ("pair_address", "created_at")`,
    // Global transactions feed: ordering / from_date-to_date range when no pair filter is set.
    `CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_created_at" ON "pair_transactions" ("created_at")`,
    // Feed filters by transaction type and by account.
    `CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_tx_type" ON "pair_transactions" ("tx_type")`,
    `CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_account_address" ON "pair_transactions" ("account_address")`,
    // "pairs/transactions by token" filters and findBestPairForToken: FK columns
    // are not auto-indexed by Postgres.
    `CREATE INDEX IF NOT EXISTS "IDX_pairs_token0_address" ON "pairs" ("token0_address")`,
    `CREATE INDEX IF NOT EXISTS "IDX_pairs_token1_address" ON "pairs" ("token1_address")`,
    // ?listed=true is the common (small) filtered slice — a partial index keeps it tiny.
    `CREATE INDEX IF NOT EXISTS "IDX_dex_tokens_listed" ON "dex_tokens" ("listed") WHERE "listed" = true`,
  ];

  /** Back-compat: the full ordered statement list (required first, then indexes). */
  static get STATEMENTS(): readonly string[] {
    return [...this.REQUIRED_STATEMENTS, ...this.INDEX_STATEMENTS];
  }

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    // Use a single dedicated connection so the advisory lock and the DDL run on
    // the same session (advisory locks are session-scoped).
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query('SELECT pg_advisory_lock($1)', [
        DexSchemaBootstrapService.ADVISORY_LOCK_KEY,
      ]);
      try {
        // Required: let failures propagate and abort startup.
        for (const statement of DexSchemaBootstrapService.REQUIRED_STATEMENTS) {
          await queryRunner.query(statement);
        }
        // Best-effort: log and continue so a missing-index hiccup never blocks boot.
        for (const statement of DexSchemaBootstrapService.INDEX_STATEMENTS) {
          try {
            await queryRunner.query(statement);
          } catch (error) {
            this.logger.error(
              `DEX schema bootstrap index statement failed: ${statement}`,
              error instanceof Error ? error.stack : String(error),
            );
          }
        }
      } finally {
        await queryRunner.query('SELECT pg_advisory_unlock($1)', [
          DexSchemaBootstrapService.ADVISORY_LOCK_KEY,
        ]);
      }
    } finally {
      await queryRunner.release();
    }
  }
}
