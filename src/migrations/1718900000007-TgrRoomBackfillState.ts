import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #7 (plan §4.6 / §6.2): `room_backfill_state` — single-row resume
 * cursor for the eager room backfill, fixed PK `id='global'`.
 */
export class TgrRoomBackfillState1718900000007 implements MigrationInterface {
  name = 'TgrRoomBackfillState1718900000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "room_backfill_state" (
        "id" character varying NOT NULL DEFAULT 'global',
        "last_height" integer,
        "batch_offset" integer NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT "PK_room_backfill_state_id" PRIMARY KEY ("id")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "room_backfill_state"`);
  }
}
