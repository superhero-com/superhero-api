import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #3 (plan §4.3): `room_membership` (generated PK `id`) — desired
 * membership ledger. Creates the `role`/`relay_state` enum types, the unique
 * `(sale_address, member_address)`, the `(sale_address, relay_state)` scan index,
 * `(member_address)`, and the partial `(sale_address) WHERE eligible=true`.
 */
export class TgrRoomMembership1718900000003 implements MigrationInterface {
  name = 'TgrRoomMembership1718900000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."room_membership_role_enum" AS ENUM('member', 'admin')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."room_membership_relay_state_enum" AS ENUM('pending_add', 'added', 'pending_remove', 'removed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "room_membership" (
        "id" SERIAL NOT NULL,
        "sale_address" character varying NOT NULL,
        "member_address" character varying NOT NULL,
        "member_pubkey" character varying,
        "role" "public"."room_membership_role_enum" NOT NULL DEFAULT 'member',
        "eligible" boolean NOT NULL DEFAULT false,
        "relay_state" "public"."room_membership_relay_state_enum" NOT NULL DEFAULT 'pending_add',
        "held_until_height" integer,
        "last_published_at" TIMESTAMP WITH TIME ZONE,
        "last_reconciled_at" TIMESTAMP WITH TIME ZONE,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT "PK_room_membership_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_room_membership_sale_member" ON "room_membership" ("sale_address", "member_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_room_membership_sale_relay_state" ON "room_membership" ("sale_address", "relay_state")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_room_membership_member_address" ON "room_membership" ("member_address")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_room_membership_eligible" ON "room_membership" ("sale_address") WHERE eligible = true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_room_membership_eligible"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_room_membership_member_address"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_room_membership_sale_relay_state"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."uq_room_membership_sale_member"`,
    );
    await queryRunner.query(`DROP TABLE "room_membership"`);
    await queryRunner.query(
      `DROP TYPE "public"."room_membership_relay_state_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."room_membership_role_enum"`);
  }
}
