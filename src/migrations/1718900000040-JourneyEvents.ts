import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Anonymous user-journey events (see src/journey). Only a random per-browser
 * id, the step name, a route pattern and timestamps; no IP, user agent,
 * wallet or session column. Rows older than 180 days are deleted daily by
 * JourneyRetentionService.
 *
 * `IF NOT EXISTS` because `DB_SYNC=true` environments may already have the
 * table from the entity.
 */
export class JourneyEvents1718900000040 implements MigrationInterface {
  name = 'JourneyEvents1718900000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "journey_events" (
        "id" bigserial PRIMARY KEY,
        "anon_id" uuid NOT NULL,
        "event" varchar(48) NOT NULL,
        "page" varchar(96) NOT NULL DEFAULT '(other)',
        "occurred_at" timestamptz NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_JOURNEY_EVENTS_OCCURRED_AT" ON "journey_events" ("occurred_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_JOURNEY_EVENTS_EVENT_OCCURRED_AT" ON "journey_events" ("event", "occurred_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_JOURNEY_EVENTS_ANON_OCCURRED_AT" ON "journey_events" ("anon_id", "occurred_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "journey_events"`);
  }
}
