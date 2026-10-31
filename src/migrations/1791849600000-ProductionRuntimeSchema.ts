import { MigrationInterface, QueryRunner } from 'typeorm';

/** Move legacy startup DDL to the privileged migration phase. */
export class ProductionRuntimeSchema1791849600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS token_eligibility_counts (
      symbol varchar PRIMARY KEY,
      post_count integer NOT NULL DEFAULT 0,
      stored_post_count integer NOT NULL DEFAULT 0,
      content_post_count integer NOT NULL DEFAULT 0,
      refreshed_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    )`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS token_eligibility_refresh_state (
      id varchar PRIMARY KEY,
      last_processed_created_at timestamp NULL,
      last_processed_post_id varchar NULL,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    )`);
    await queryRunner.query(
      'ALTER TABLE dex_tokens ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT false',
    );
    // Use the same names as the existing bootstrap/entity indexes. Existing
    // deployments keep their indexes; missing ones are created once at migration.
    for (const statement of [
      'CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_pair_created_at" ON pair_transactions (pair_address, created_at)',
      'CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_created_at" ON pair_transactions (created_at)',
      'CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_tx_type" ON pair_transactions (tx_type)',
      'CREATE INDEX IF NOT EXISTS "IDX_pairs_token0_address" ON pairs (token0_address)',
      'CREATE INDEX IF NOT EXISTS "IDX_pairs_token1_address" ON pairs (token1_address)',
      'CREATE INDEX IF NOT EXISTS "IDX_dex_tokens_listed" ON dex_tokens (listed) WHERE listed = true',
    ]) {
      await queryRunner.query(statement);
    }
  }

  async down(): Promise<void> {
    // These objects predate this migration and may contain production data.
    // Older application versions still need them; rollback must preserve them.
  }
}
