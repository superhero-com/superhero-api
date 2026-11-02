import { MigrationInterface, QueryRunner } from 'typeorm';

/** File-backed renditions may exceed the legacy in-memory object ceiling. */
export class ShortsFileStorageReferences1793145604000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`ALTER TABLE shorts_storage_references
      DROP CONSTRAINT shorts_storage_references_bytes_check,
      ADD CONSTRAINT shorts_storage_references_file_bytes CHECK(bytes BETWEEN 1 AND 100000000)`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_storage_references IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_storage_references WHERE bytes>67108864) AS used',
    );
    if (used)
      throw new Error('Preserve large file reference history before rollback');
    await db.query(`ALTER TABLE shorts_storage_references
      DROP CONSTRAINT shorts_storage_references_file_bytes,
      ADD CONSTRAINT shorts_storage_references_bytes_check CHECK(bytes BETWEEN 1 AND 67108864)`);
  }
}
