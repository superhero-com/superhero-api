import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #6 (plan §4.5): `token_balance` — authoritative AEX9 balances in
 * raw base units, composite PK `(token_address, holder_address)`.
 */
export class TgrTokenBalance1718900000006 implements MigrationInterface {
  name = 'TgrTokenBalance1718900000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "token_balance" (
        "token_address" character varying NOT NULL,
        "holder_address" character varying NOT NULL,
        "balance" numeric NOT NULL DEFAULT '0',
        "updated_height" integer NOT NULL DEFAULT 0,
        "last_reconciled_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_token_balance" PRIMARY KEY ("token_address", "holder_address")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "token_balance"`);
  }
}
