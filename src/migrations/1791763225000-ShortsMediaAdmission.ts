import { MigrationInterface, QueryRunner } from 'typeorm';

/** Preserve lifecycle retries while shared media transfer capacity is unavailable. */
export class ShortsMediaAdmission1791763225000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`ALTER TABLE shorts_lifecycle_jobs DROP CONSTRAINT shorts_lifecycle_jobs_result_check,
      ADD CONSTRAINT shorts_lifecycle_jobs_result_check CHECK(result IN
        ('checked','publication_pending','retention_pending','reconciliation_required','failed','capacity_wait'))`);
  }
  async down(db: QueryRunner): Promise<void> {
    // The constraint refuses downgrade while capacity waits exist; no saved work is rewritten.
    await db.query(`ALTER TABLE shorts_lifecycle_jobs DROP CONSTRAINT shorts_lifecycle_jobs_result_check,
      ADD CONSTRAINT shorts_lifecycle_jobs_result_check CHECK(result IN
        ('checked','publication_pending','retention_pending','reconciliation_required','failed'))`);
  }
}
