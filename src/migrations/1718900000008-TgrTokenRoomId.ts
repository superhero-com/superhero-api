import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #8: add `Token.room_id` — the source of truth for "room created".
 *
 * `room_id` holds the NIP-29 group id (= `sale_address`) once the room is
 * CONFIRMED created on the relay; NULL = no room yet. It is set on the `9007` ok
 * ACK (`RoomBackfillService.onPublishAck`) alongside `has_nostr_room` /
 * `nostr_room_created_at`, and the 5-minute provisioning cron selects roomless
 * tokens by `room_id IS NULL`. A partial index (`WHERE room_id IS NULL`, mirroring
 * the partial index in migration #1) keeps that selection cheap as the roomless
 * set shrinks toward empty.
 */
export class TgrTokenRoomId1718900000008 implements MigrationInterface {
  name = 'TgrTokenRoomId1718900000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "token" ADD "room_id" character varying`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_token_room_id_null" ON "token" ("room_id") WHERE room_id IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_token_room_id_null"`);
    await queryRunner.query(`ALTER TABLE "token" DROP COLUMN "room_id"`);
  }
}
