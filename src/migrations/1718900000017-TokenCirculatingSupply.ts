import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persists middleware's AEX9 `event_supply` as `circulating_supply` on
 * `token`, fetched during `getTokeLivePrice` (token sync / PullTokenInfoQueue)
 * so the token detail page can stop calling `{mdw}/v3/aex9/{address}` from
 * the browser just to read this one field.
 */
export class TokenCirculatingSupply1718900000017
  implements MigrationInterface
{
  name = 'TokenCirculatingSupply1718900000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "token"
      ADD COLUMN IF NOT EXISTS "circulating_supply" numeric NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "token"
      DROP COLUMN IF EXISTS "circulating_supply"
    `);
  }
}
