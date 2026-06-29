import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #1 (plan §4.1 / §4.6): add the four `Token` columns + the
 * `nostr_room_state` Postgres enum + the partial index used by the publish-pending
 * scan (`WHERE nostr_room_state <> 'created'`).
 */
export class TgrTokenColumns1718900000001 implements MigrationInterface {
  name = 'TgrTokenColumns1718900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."token_nostr_room_state_enum" AS ENUM('none', 'pending', 'created', 'failed', 'deleted')`,
    );
    await queryRunner.query(
      `ALTER TABLE "token" ADD "nostr_group_id" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "token" ADD "has_nostr_room" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "token" ADD "nostr_room_created_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "token" ADD "nostr_room_state" "public"."token_nostr_room_state_enum" NOT NULL DEFAULT 'none'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_token_nostr_group_id" ON "token" ("nostr_group_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_token_nostr_room_state_pending" ON "token" ("nostr_room_state") WHERE nostr_room_state <> 'created'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_token_nostr_room_state_pending"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_token_nostr_group_id"`);
    await queryRunner.query(
      `ALTER TABLE "token" DROP COLUMN "nostr_room_state"`,
    );
    await queryRunner.query(
      `ALTER TABLE "token" DROP COLUMN "nostr_room_created_at"`,
    );
    await queryRunner.query(`ALTER TABLE "token" DROP COLUMN "has_nostr_room"`);
    await queryRunner.query(`ALTER TABLE "token" DROP COLUMN "nostr_group_id"`);
    await queryRunner.query(`DROP TYPE "public"."token_nostr_room_state_enum"`);
  }
}
