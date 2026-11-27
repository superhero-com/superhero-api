import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

async function shortsOriginalUploadsReaders(db: QueryRunner, reverse: boolean) {
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

async function shortsOriginalUploadsLimits(db: QueryRunner, original: boolean) {
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

export class ShortsOriginalUploadRequests1793232000001 extends FeatureMigration {
  readonly steps = {
    /** Capacity for original uploads and their source manifests. */
    ShortsOriginalUploads: {
      async up(db: QueryRunner): Promise<void> {
        await shortsOriginalUploadsLimits(db, true);
        await shortsOriginalUploadsReaders(db, false);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(`LOCK TABLE shorts_upload_sessions,shorts_upload_parts,
      shorts_upload_admission,shorts_ingestion,shorts_delivery_staging IN ACCESS EXCLUSIVE MODE`);
        // Keep the widened readers while any original-format jobs or sessions exist,
        // even if their parts have already been reclaimed. Never delete to roll back.
        await db.query(`DO $$ BEGIN IF
      EXISTS(SELECT FROM shorts_upload_sessions WHERE input ? 'processingProfile' OR (input->>'bytes')::bigint>41943040)
      OR EXISTS(SELECT FROM shorts_ingestion WHERE input ? 'processingProfile' OR (input->>'bytes')::bigint>41943040)
      THEN RAISE EXCEPTION 'Preserve accepted original uploads before rollback'; END IF; END $$`);
        await shortsOriginalUploadsReaders(db, true);
        await shortsOriginalUploadsLimits(db, false);
      },
    },

    ShortsUploadRequests: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        // Deliberately no session FK: the identity survives expiry/byte cleanup.
        await db.query(`CREATE TABLE ${s}.shorts_upload_requests (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      creator varchar(100) NOT NULL, request_key uuid NOT NULL,
      request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
      upload_id varchar(80) NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,creator,request_key),
      UNIQUE(network,contract,upload_id),
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_runtime(network,contract)
    );
    REVOKE ALL ON ${s}.shorts_upload_requests FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_upload_request_guard() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
    BEGIN
      IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION 'Upload request identities are immutable' USING ERRCODE='SH409';
      END IF;
      IF NOT EXISTS(SELECT FROM ${s}.shorts_upload_sessions WHERE network=NEW.network
        AND contract=NEW.contract AND id=NEW.upload_id AND creator=NEW.creator) THEN
        RAISE EXCEPTION 'Upload request requires its accepted session' USING ERRCODE='SH409';
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_upload_request_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_upload_request_identity BEFORE INSERT OR UPDATE OR DELETE
      ON ${s}.shorts_upload_requests FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_upload_request_guard();
    CREATE TRIGGER shorts_upload_request_truncate BEFORE TRUNCATE
      ON ${s}.shorts_upload_requests FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_upload_request_guard()`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_upload_requests IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_upload_requests) AS used',
        );
        if (used)
          throw new Error('Preserve upload request identities before rollback');
        await db.query(
          'DROP TABLE shorts_upload_requests; DROP FUNCTION shorts_upload_request_guard()',
        );
      },
    },
  };
}
