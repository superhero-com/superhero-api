import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsUploadRequests1793232007000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
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
  }
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
  }
}
