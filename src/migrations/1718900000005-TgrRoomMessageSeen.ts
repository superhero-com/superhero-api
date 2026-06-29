import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #5 (plan §7.1): `room_message_seen` — new-message dedup key,
 * PK `event_id`. Indexed by `sale_address`.
 */
export class TgrRoomMessageSeen1718900000005 implements MigrationInterface {
  name = 'TgrRoomMessageSeen1718900000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "room_message_seen" (
        "event_id" character varying NOT NULL,
        "sale_address" character varying NOT NULL,
        "seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_room_message_seen_event_id" PRIMARY KEY ("event_id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_room_message_seen_sale_address" ON "room_message_seen" ("sale_address")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_room_message_seen_sale_address"`,
    );
    await queryRunner.query(`DROP TABLE "room_message_seen"`);
  }
}
