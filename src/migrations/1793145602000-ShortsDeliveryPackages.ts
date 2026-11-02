import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable acknowledgements for the initial, immutable original-media generation. */
export class ShortsDeliveryPackages1793145602000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_delivery_packages (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, short_id varchar(80) NOT NULL,
      source_key char(64) NOT NULL CHECK(source_key ~ '^[a-f0-9]{64}$'),
      source_identity text NOT NULL CHECK(octet_length(source_identity)<=16384),
      prepared jsonb NOT NULL CHECK(jsonb_typeof(prepared)='object' AND prepared ?& ARRAY['version','cid','playlist','playlists','files'] AND octet_length(prepared::text)<=147456
        AND prepared->'version'='3'::jsonb AND jsonb_typeof(prepared->'cid')='string' AND prepared->>'cid' ~ '^b[a-z2-7]{20,118}$'
        AND jsonb_typeof(prepared->'playlist')='string' AND jsonb_typeof(prepared->'playlists')='object'
        AND jsonb_typeof(prepared->'files')='array' AND jsonb_array_length(prepared->'files') BETWEEN 7 AND 256),
      acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,short_id,source_key),
      UNIQUE(network,contract,short_id),
      FOREIGN KEY(network,contract,short_id) REFERENCES ${s}.shorts_content(network,contract,id)
    );
    CREATE INDEX shorts_delivery_package_cid ON ${s}.shorts_delivery_packages((prepared->>'cid'));
    REVOKE ALL ON ${s}.shorts_delivery_packages FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_delivery_package_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      DECLARE content jsonb; expected jsonb;
      BEGIN
        IF TG_OP<>'INSERT' THEN
          RAISE EXCEPTION 'Acknowledged delivery packages are immutable' USING ERRCODE='SH409';
        END IF;
        SELECT body INTO content FROM ${s}.shorts_content
          WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.short_id FOR SHARE;
        IF NOT FOUND OR NOT content ? 'original' THEN
          RAISE EXCEPTION 'Original delivery source missing' USING ERRCODE='SH400';
        END IF;
        PERFORM ${s}.shorts_validate_original(content);
        expected=jsonb_build_object('id',NEW.short_id,'network',NEW.network,'contract',NEW.contract,
          'cid',content->'cid','bytes',content->'bytes','sha256',content->'original'->'sha256',
          'cidVersion',content->'original'->'importProfile','delivery',content->'derivatives'->'cid',
          'assets',content->'derivatives'->'assetsCid','profile',content->'derivatives'->'profile',
          'fingerprint',content->'derivatives'->'fingerprint','generation',content->'derivatives'->'generation',
          'videos',(SELECT jsonb_agg(jsonb_build_object('name',v->'name','width',v->'width','height',v->'height','frameRate',v->'frameRate')
            ORDER BY v->>'name' COLLATE "C") FROM jsonb_array_elements(content->'derivatives'->'videos') v),
          'files',(SELECT jsonb_agg(jsonb_build_object('name',f->'name','bytes',f->'bytes','sha256',f->'sha256')
            ORDER BY f->>'name' COLLATE "C") FROM jsonb_array_elements(content->'files') f));
        IF NEW.source_identity::jsonb IS DISTINCT FROM expected
          OR NEW.source_key<>encode(sha256(convert_to(E'hls-v3\\n'||NEW.source_identity,'UTF8')),'hex')
          OR NEW.prepared->>'cid' IN (content->>'cid',content->'derivatives'->>'cid',content->'derivatives'->>'assetsCid') THEN
          RAISE EXCEPTION 'Delivery acknowledgement differs from original generation' USING ERRCODE='SH409';
        END IF;
        NEW.acknowledged_at=clock_timestamp();
        RETURN NEW;
      END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_delivery_package_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_delivery_package_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_delivery_packages
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_delivery_package_guard();
    CREATE TRIGGER shorts_delivery_package_truncate BEFORE TRUNCATE ON ${s}.shorts_delivery_packages
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_delivery_package_guard()`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_delivery_packages IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_delivery_packages) AS used',
    );
    if (used)
      throw new Error(
        'Preserve acknowledged delivery packages before rollback',
      );
    await db.query(
      'DROP TABLE shorts_delivery_packages; DROP FUNCTION shorts_delivery_package_guard()',
    );
  }
}
