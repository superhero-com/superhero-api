import { MigrationInterface, QueryRunner } from 'typeorm';

export class TokenPriceAlerts1718900000038 implements MigrationInterface {
  name = 'TokenPriceAlerts1718900000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "token_price_alerts" ("id" SERIAL NOT NULL, "address" character varying NOT NULL, "sale_address" character varying NOT NULL, "direction" character varying(8) NOT NULL, "target_ae" numeric NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6), "triggered_at" TIMESTAMP, CONSTRAINT "PK_token_price_alerts_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "token_price_alerts_address_idx" ON "token_price_alerts" ("address")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "token_price_alerts_active_idx" ON "token_price_alerts" ("sale_address") WHERE triggered_at IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "token_price_alerts"`);
  }
}
