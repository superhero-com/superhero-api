import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persisted watermark for the social-graph one-shot recovery backfill. Without
 * it, `SocialGraphBackfillService` re-walked and re-decoded the contract's whole
 * call history on every boot. The row records the highest block already
 * recovered so subsequent boots stop early instead of replaying it.
 *
 * Keyed by contract address: a redeploy mints a new address and so recovers
 * afresh, rather than inheriting a stale watermark.
 */
export class SocialGraphBackfillState1718900000029 implements MigrationInterface {
  name = 'SocialGraphBackfillState1718900000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "social_graph_backfill_state" (
         "contract_address" character varying NOT NULL,
         "last_backfilled_height" integer,
         "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_social_graph_backfill_state" PRIMARY KEY ("contract_address")
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "social_graph_backfill_state"`,
    );
  }
}
