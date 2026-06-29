import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #2 (plan §4.2): `community_room` (PK `sale_address`) — indexed
 * RoomManagement state. Indexes on `(is_private)`, `(state_synced_at)`, and GIN
 * on the `moderators`/`muted` jsonb columns.
 */
export class TgrCommunityRoom1718900000002 implements MigrationInterface {
  name = 'TgrCommunityRoom1718900000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "community_room" (
        "sale_address" character varying NOT NULL,
        "token_address" character varying NOT NULL,
        "symbol" character varying NOT NULL,
        "owner_address" character varying NOT NULL,
        "is_private" boolean NOT NULL DEFAULT false,
        "min_token_threshold" numeric NOT NULL DEFAULT '0',
        "moderators" jsonb,
        "muted" jsonb,
        "is_community" boolean NOT NULL DEFAULT false,
        "state_synced_at" TIMESTAMP WITH TIME ZONE,
        "created_height" integer,
        "deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_community_room_sale_address" PRIMARY KEY ("sale_address")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_community_room_is_private" ON "community_room" ("is_private")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_community_room_state_synced_at" ON "community_room" ("state_synced_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_community_room_moderators" ON "community_room" USING GIN ("moderators")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_community_room_muted" ON "community_room" USING GIN ("muted")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_community_room_muted"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_community_room_moderators"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_community_room_state_synced_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_community_room_is_private"`,
    );
    await queryRunner.query(`DROP TABLE "community_room"`);
  }
}
