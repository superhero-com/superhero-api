import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TGR migration #4 (plan §4.4): `room_notification_preference` — per-room mute,
 * composite PK `(address, sale_address)`.
 */
export class TgrRoomNotificationPreference1718900000004 implements MigrationInterface {
  name = 'TgrRoomNotificationPreference1718900000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "room_notification_preference" (
        "address" character varying NOT NULL,
        "sale_address" character varying NOT NULL,
        "muted" boolean NOT NULL DEFAULT false,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT "PK_room_notification_preference" PRIMARY KEY ("address", "sale_address")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "room_notification_preference"`);
  }
}
