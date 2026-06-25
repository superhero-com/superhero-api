import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Ensures DEX schema additions that post-date the original tables exist in
 * every environment — including production, where TypeORM `synchronize` is
 * disabled (see src/configs/database.ts) and would otherwise never create the
 * new `dex_tokens.listed` column or the pair-history index.
 *
 * Every statement is idempotent (`IF NOT EXISTS`), so this is a no-op once the
 * schema is up to date and is safe to run on every boot. A failed statement is
 * logged but does not crash startup. This is a deliberate stop-gap until the
 * project adopts real TypeORM migrations.
 */
@Injectable()
export class DexSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(DexSchemaBootstrapService.name);

  // The index name MUST match the @Index decorator on PairTransaction so that
  // synchronize-based environments and this bootstrap converge on a single
  // index instead of creating two with different generated names.
  static readonly STATEMENTS: readonly string[] = [
    `ALTER TABLE "dex_tokens" ADD COLUMN IF NOT EXISTS "listed" boolean NOT NULL DEFAULT false`,
    `CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_pair_created_at" ON "pair_transactions" ("pair_address", "created_at")`,
  ];

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    for (const statement of DexSchemaBootstrapService.STATEMENTS) {
      try {
        await this.dataSource.query(statement);
      } catch (error) {
        // Don't take the whole app down over a schema bootstrap hiccup;
        // synchronize-based environments may already own the schema. Surface
        // the failure loudly so a genuinely missing column is noticed.
        this.logger.error(
          `DEX schema bootstrap statement failed: ${statement}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
