import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Append-only history of X verification attempts.
 *
 * `profile_x_posting_rewards.error` holds only the most recent error and is
 * overwritten on every run, so there is no way to see that an address has
 * failed repeatedly, or that many addresses began failing at the same time.
 * This table keeps each attempt so the dashboard can answer both.
 *
 * Purely additive: a new table and its indexes. No existing table, column or
 * row is altered, renamed or dropped, and nothing already running reads or
 * writes it, so this cannot change the behaviour of anything currently live.
 *
 * Production runs migrations on boot with `synchronize` forced off (see
 * `DB_SYNC_ENABLED` in `src/configs/database.ts`), so this file is the only
 * thing that creates the table there. Dev and testnet boot with `DB_SYNC=true`
 * and may have already created it from the entity — hence `IF NOT EXISTS`
 * throughout, so running this against such a database is a no-op rather than
 * an error.
 */
export class XVerificationAttempts1718900000032 implements MigrationInterface {
  name = 'XVerificationAttempts1718900000032';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "profile_x_verification_attempts" (
         "id" SERIAL NOT NULL,
         "address" character varying NOT NULL,
         "x_username" character varying,
         "outcome" character varying NOT NULL,
         "source" character varying NOT NULL,
         "error_code" character varying,
         "detail" character varying(500),
         "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
         CONSTRAINT "pk_profile_x_verification_attempts" PRIMARY KEY ("id")
       )`,
    );

    // Per-address history, newest first.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_x_verification_attempts_address_created"
         ON "profile_x_verification_attempts" ("address", "created_at")`,
    );
    // "What happened in the last hour / day" — the dashboard's default view.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_x_verification_attempts_created"
         ON "profile_x_verification_attempts" ("created_at")`,
    );
    // "Which failure is spiking" — grouped by code over a window.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_x_verification_attempts_error_created"
         ON "profile_x_verification_attempts" ("error_code", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Indexes go with the table, but drop them explicitly so a partially
    // applied `up` (table created, an index not) still reverses cleanly.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_x_verification_attempts_error_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_x_verification_attempts_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_x_verification_attempts_address_created"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "profile_x_verification_attempts"`,
    );
  }
}
