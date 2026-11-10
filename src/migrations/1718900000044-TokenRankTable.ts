import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves the market-cap rank from `token.rank` into `token_rank`. A new token
 * shifts the rank of every token below it (~41k rows per creation), and on
 * `token` each of those updates rewrote a wide row and all of its indexes.
 *
 * `token.rank` and `IDX_TOKEN_RANK` stay until a later release, so rolling
 * back is a code revert.
 */
export class TokenRankTable1718900000044 implements MigrationInterface {
  name = 'TokenRankTable1718900000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "token_rank" ("sale_address" character varying NOT NULL, "rank" integer NOT NULL, CONSTRAINT "PK_16da97d8531ae6719c2f650da40" PRIMARY KEY ("sale_address"), CONSTRAINT "FK_16da97d8531ae6719c2f650da40" FOREIGN KEY ("sale_address") REFERENCES "token"("sale_address") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_48b416e5ed664b0d2f9f050dab" ON "token_rank" ("rank")`,
    );
    // Copies every placed rank, so readers see the same values until the next
    // refresh. A token still at the unranked sentinel gets no row, which reads
    // the same.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'token'
            AND column_name = 'rank'
        ) THEN
          INSERT INTO "token_rank" ("sale_address", "rank")
          SELECT "sale_address", "rank" FROM "token" WHERE "rank" < 2147483647
          ON CONFLICT DO NOTHING;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "token_rank"`);
  }
}
