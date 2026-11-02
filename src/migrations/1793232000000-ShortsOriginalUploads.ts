import { MigrationInterface, QueryRunner } from 'typeorm';

/** Reader/storage capacity only. The original upload writer remains opt-in. */
export class ShortsOriginalUploads1793232000000 implements MigrationInterface {
  private async readers(db: QueryRunner, reverse: boolean) {
    const before =
      "AND (delivery_short_id IS NULL OR payload->'mediaProtocol'='3'::jsonb)";
    const after = `${before} AND (input->>'bytes')::bigint<=CASE
      WHEN payload->'maxSourceBytes'='100000000'::jsonb THEN 100000000 ELSE 41943040 END`;
    const [{ definition }] = await db.query(
      "SELECT pg_get_functiondef('shorts_media_worker(text,jsonb)'::regprocedure) AS definition",
    );
    const from = reverse ? after : before,
      to = reverse ? before : after;
    if (definition.split(from).length !== 2)
      throw new Error('Unexpected source-reader predecessor');
    await db.query(definition.replace(from, to));
  }
  private async limits(db: QueryRunner, original: boolean) {
    await db.query(`ALTER TABLE shorts_upload_parts
      DROP CONSTRAINT shorts_upload_parts_part_check,
      ADD CONSTRAINT shorts_upload_parts_part_check CHECK(part BETWEEN 0 AND ${original ? 95 : 39});
      ALTER TABLE shorts_upload_admission
      DROP CONSTRAINT shorts_upload_admission_bytes_check,
      ADD CONSTRAINT shorts_upload_admission_bytes_check CHECK(bytes BETWEEN 1 AND ${original ? 100000000 : 41943040});
      ALTER TABLE shorts_upload_sessions
      DROP CONSTRAINT shorts_upload_sessions_direct_parts_check,
      ADD CONSTRAINT shorts_upload_sessions_direct_parts_check
        CHECK(jsonb_typeof(direct_parts)='object' AND octet_length(direct_parts::text)<=${original ? 131072 : 65536});
      ALTER TABLE shorts_delivery_staging
      DROP CONSTRAINT shorts_delivery_staging_manifest_check,
      ADD CONSTRAINT shorts_delivery_staging_manifest_check
        CHECK(octet_length(manifest) BETWEEN 1 AND ${original ? 98304 : 32768})`);
  }
  async up(db: QueryRunner): Promise<void> {
    await this.limits(db, true);
    await this.readers(db, false);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(`LOCK TABLE shorts_upload_sessions,shorts_upload_parts,
      shorts_upload_admission,shorts_ingestion,shorts_delivery_staging IN ACCESS EXCLUSIVE MODE`);
    // Keep the widened readers while any original-format jobs or sessions exist,
    // even if their parts have already been reclaimed. Never delete to roll back.
    await db.query(`DO $$ BEGIN IF
      EXISTS(SELECT FROM shorts_upload_sessions WHERE input ? 'processingProfile' OR (input->>'bytes')::bigint>41943040)
      OR EXISTS(SELECT FROM shorts_ingestion WHERE input ? 'processingProfile' OR (input->>'bytes')::bigint>41943040)
      THEN RAISE EXCEPTION 'Preserve accepted original uploads before rollback'; END IF; END $$`);
    await this.readers(db, true);
    await this.limits(db, false);
  }
}
