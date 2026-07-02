import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #9 (access-ledger plan §5): the access-transition ledger.
 *
 * Creates `room_membership_event` (append-only grant/revoke audit + push source)
 * and adds the notification-facing access-state columns to `room_membership`
 * (`access_state`, `access_changed_at`, `pending_revoke_since`,
 * `pending_revoke_reason`).
 *
 * **Backfill (critical):** seeds every currently-added member as
 * `access_state='granted'` so the deploy does NOT emit a "you're in" push to
 * everyone already in a room. Effective access = `relay_state='added'` (independent
 * of `eligible`, so room admins are seeded too). It ALSO inserts a historical
 * `access_granted` ledger row per backfilled member (reason `backfill`, pre-stamped
 * `notified_at`) so post-deploy first-grant detection is correct — a later
 * revoke→regain reads as "you're back", not a fresh "Welcome".
 */
export class TgrRoomMembershipEvent1718900000009 implements MigrationInterface {
  name = 'TgrRoomMembershipEvent1718900000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── access-transition ledger ───────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TYPE "public"."room_membership_event_event_enum" AS ENUM('access_granted', 'access_revoked')`,
    );
    await queryRunner.query(
      `CREATE TABLE "room_membership_event" (
        "id" BIGSERIAL NOT NULL,
        "sale_address" character varying NOT NULL,
        "member_address" character varying NOT NULL,
        "event" "public"."room_membership_event_event_enum" NOT NULL,
        "reason" character varying NOT NULL,
        "is_first_grant" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        "notified_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_room_membership_event_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_room_membership_event_sale_member" ON "room_membership_event" ("sale_address", "member_address", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_room_membership_event_unnotified" ON "room_membership_event" ("notified_at") WHERE notified_at IS NULL`,
    );

    // ── access-state columns on room_membership ────────────────────────────────
    await queryRunner.query(
      `CREATE TYPE "public"."room_membership_access_state_enum" AS ENUM('none', 'granted')`,
    );
    await queryRunner.query(
      `ALTER TABLE "room_membership"
        ADD COLUMN "access_state" "public"."room_membership_access_state_enum" NOT NULL DEFAULT 'none',
        ADD COLUMN "access_changed_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "pending_revoke_since" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "pending_revoke_reason" character varying`,
    );

    // ── backfill: current members are already granted (no push storm on deploy) ─
    await queryRunner.query(
      `UPDATE "room_membership"
        SET "access_state" = 'granted', "access_changed_at" = "updated_at"
        WHERE "relay_state" = 'added'`,
    );

    // Seed a historical `access_granted` ledger row per backfilled member so
    // first-grant detection is correct AFTER deploy: their genuine first grant
    // happened pre-ledger, so a later revoke→regain must read as "you're back"
    // (is_first_grant=false), not a fresh "Welcome". `notified_at` is set (never
    // pushed — these are historical, not enqueued) so they stay out of the
    // unnotified index. `is_first_grant=true` records that this WAS their first grant.
    await queryRunner.query(
      `INSERT INTO "room_membership_event"
        ("sale_address", "member_address", "event", "reason", "is_first_grant", "created_at", "notified_at")
       SELECT "sale_address", "member_address", 'access_granted', 'backfill', true, "updated_at", "updated_at"
       FROM "room_membership"
       WHERE "relay_state" = 'added'`,
    );

    // Partial index for the finalizer sweep (rows with an armed pending revoke).
    await queryRunner.query(
      `CREATE INDEX "idx_room_membership_pending_revoke" ON "room_membership" ("pending_revoke_since") WHERE pending_revoke_since IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_room_membership_pending_revoke"`,
    );
    await queryRunner.query(
      `ALTER TABLE "room_membership"
        DROP COLUMN "pending_revoke_reason",
        DROP COLUMN "pending_revoke_since",
        DROP COLUMN "access_changed_at",
        DROP COLUMN "access_state"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."room_membership_access_state_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_room_membership_event_unnotified"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_room_membership_event_sale_member"`,
    );
    await queryRunner.query(`DROP TABLE "room_membership_event"`);
    await queryRunner.query(
      `DROP TYPE "public"."room_membership_event_event_enum"`,
    );
  }
}
