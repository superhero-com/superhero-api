import { MigrationInterface, QueryRunner } from 'typeorm';

/** Makes accepted encrypted source children inspectable by transactional reference guards. */
export class ShortsAcceptedManifests1793491201000 implements MigrationInterface {
  private async epoch(db: QueryRunner, reverse: boolean) {
    const [{ definition }] = await db.query(
      "SELECT pg_get_functiondef('shorts_private_reference_epoch()'::regprocedure) AS definition",
    );
    let changed = definition;
    for (const side of ['old_body', 'new_body']) {
      const old = `${side}->'delivery_short_id'`;
      const next = `${old},${side}->'source_manifest'`;
      const from = reverse ? next : old;
      if (changed.split(from).length !== 2)
        throw new Error('Unexpected private source epoch predecessor');
      changed = changed.replace(from, reverse ? old : next);
    }
    await db.query(changed);
  }

  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = '"' + String(schema).replaceAll('"', '""') + '"';
    await db.query(`ALTER TABLE ${s}.shorts_ingestion ADD COLUMN source_manifest text
      CHECK(source_manifest IS NULL OR octet_length(source_manifest) BETWEEN 1 AND 98304);
    CREATE FUNCTION ${s}.shorts_accepted_source_refs(net text,ctr text,sid text,actor text,input jsonb,manifest text) RETURNS jsonb
      LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $source$
      DECLARE document jsonb; refs jsonb; part record; ref jsonb; prefix text; ceiling bigint; total bigint; accepted bigint;
      BEGIN
        ceiling=CASE WHEN input->>'processingProfile'='original-h264-v1' THEN 100000000 ELSE 41943040 END;
        IF input ? 'processingProfile' AND input->>'processingProfile' IS DISTINCT FROM 'original-h264-v1' THEN
          RAISE EXCEPTION 'Invalid accepted source profile' USING ERRCODE='SH400'; END IF;
        IF manifest IS NULL OR octet_length(manifest) NOT BETWEEN 1 AND 98304
          OR jsonb_typeof(input->'bytes') IS DISTINCT FROM 'number' OR COALESCE(input->>'bytes','') !~ '^[1-9][0-9]{0,8}$'
          OR input->'objectKey' IS DISTINCT FROM input#>'{manifest,key}'
          OR jsonb_typeof(input->'sha256') IS DISTINCT FROM 'string' OR COALESCE(input->>'sha256','') !~ '^[a-f0-9]{64}$'
          OR octet_length(manifest) IS DISTINCT FROM (input#>>'{manifest,bytes}')::integer
          OR encode(sha256(convert_to(manifest,'UTF8')),'hex') IS DISTINCT FROM input#>>'{manifest,sha256}' THEN
          RAISE EXCEPTION 'Accepted source manifest identity mismatch' USING ERRCODE='SH400'; END IF;
        total=(input->>'bytes')::bigint; accepted=ceiling;
        IF input ? 'acceptedMaxBytes' THEN
          IF jsonb_typeof(input->'acceptedMaxBytes') IS DISTINCT FROM 'number' OR COALESCE(input->>'acceptedMaxBytes','') !~ '^[1-9][0-9]{0,8}$' THEN
            RAISE EXCEPTION 'Invalid accepted source limit' USING ERRCODE='SH400'; END IF;
          accepted=(input->>'acceptedMaxBytes')::bigint;
        END IF;
        IF total>accepted OR accepted NOT BETWEEN 1 AND ceiling THEN
          RAISE EXCEPTION 'Accepted source exceeds its frozen limit' USING ERRCODE='SH400'; END IF;
        document=manifest::jsonb;
        IF document->'version' IS DISTINCT FROM '1'::jsonb OR document->>'id' IS DISTINCT FROM sid
          OR document->>'creator' IS DISTINCT FROM actor OR document->'bytes' IS DISTINCT FROM input->'bytes'
          OR document->'sha256' IS DISTINCT FROM input->'sha256'
          OR jsonb_typeof(document->'parts') IS DISTINCT FROM 'array'
          OR jsonb_array_length(document->'parts')<>ceil(total::numeric/1048576) THEN
          RAISE EXCEPTION 'Invalid accepted source manifest' USING ERRCODE='SH400'; END IF;
        IF split_part(input#>>'{manifest,key}','/',1) !~ '^[a-z0-9][a-z0-9_-]{0,63}$' THEN
          RAISE EXCEPTION 'Invalid accepted source prefix' USING ERRCODE='SH400'; END IF;
        prefix=split_part(input#>>'{manifest,key}','/',1)||'/'||encode(sha256(convert_to(
          '['||to_json(net)::text||','||to_json(ctr)::text||']','UTF8')),'hex')||'/';
        refs=jsonb_build_array(input->'manifest');
        FOR part IN SELECT value,ordinality FROM jsonb_array_elements(document->'parts') WITH ORDINALITY LOOP
          IF part.value->'index' IS DISTINCT FROM to_jsonb(part.ordinality-1)
            OR part.value#>'{object,bytes}' IS DISTINCT FROM to_jsonb(least(1048576::bigint,total-(part.ordinality-1)*1048576)) THEN
            RAISE EXCEPTION 'Invalid accepted source parts' USING ERRCODE='SH400'; END IF;
          refs=refs||jsonb_build_array(part.value->'object');
        END LOOP;
        FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
          IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref IS DISTINCT FROM jsonb_build_object(
              'key',ref->'key','keyId',ref->'keyId','bytes',ref->'bytes','sha256',ref->'sha256')
            OR jsonb_typeof(ref->'key') IS DISTINCT FROM 'string' OR octet_length(ref->>'key') NOT BETWEEN 1 AND 512
            OR ref->>'key' !~ '^[a-zA-Z0-9_/-]+$' OR strpos(ref->>'key','//')>0
            OR left(ref->>'key',length(prefix)) IS DISTINCT FROM prefix
            OR jsonb_typeof(ref->'keyId') IS DISTINCT FROM 'string' OR COALESCE(ref->>'keyId','') !~ '^[a-zA-Z0-9_-]{1,32}$'
            OR jsonb_typeof(ref->'sha256') IS DISTINCT FROM 'string' OR COALESCE(ref->>'sha256','') !~ '^[a-f0-9]{64}$'
            OR right(ref->>'key',length(ref->>'keyId')+length(ref->>'sha256')+2) IS DISTINCT FROM '/'||(ref->>'keyId')||'/'||(ref->>'sha256')
            OR jsonb_typeof(ref->'bytes') IS DISTINCT FROM 'number' OR COALESCE(ref->>'bytes','') !~ '^[1-9][0-9]{0,8}$'
            OR (ref->>'bytes')::bigint>100000000 THEN
            RAISE EXCEPTION 'Invalid accepted source reference' USING ERRCODE='SH400'; END IF;
        END LOOP;
        IF EXISTS(SELECT FROM jsonb_array_elements(refs) a CROSS JOIN jsonb_array_elements(refs) b
          WHERE a.value->'key'=b.value->'key' AND a.value IS DISTINCT FROM b.value) THEN
          RAISE EXCEPTION 'Conflicting accepted source references' USING ERRCODE='SH400'; END IF;
        RETURN refs;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Invalid accepted source data' USING ERRCODE='SH400';
      END $source$;
    REVOKE ALL ON FUNCTION ${s}.shorts_accepted_source_refs(text,text,text,text,jsonb,text) FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_accepted_manifest_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      BEGIN
        IF TG_OP='TRUNCATE' OR (TG_OP='DELETE' AND OLD.source_manifest IS NOT NULL) THEN
          RAISE EXCEPTION 'Preserve accepted source manifest history' USING ERRCODE='SH409'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        IF TG_OP='UPDATE' AND OLD.source_manifest IS NOT NULL THEN
          IF ROW(OLD.network,OLD.contract,OLD.id,OLD.creator,OLD.source_manifest) IS DISTINCT FROM
              ROW(NEW.network,NEW.contract,NEW.id,NEW.creator,NEW.source_manifest)
            OR jsonb_build_array(OLD.input->'objectKey',OLD.input->'manifest',OLD.input->'bytes',OLD.input->'sha256',OLD.input->'processingProfile',OLD.input->'acceptedMaxBytes') IS DISTINCT FROM
              jsonb_build_array(NEW.input->'objectKey',NEW.input->'manifest',NEW.input->'bytes',NEW.input->'sha256',NEW.input->'processingProfile',NEW.input->'acceptedMaxBytes') THEN
            RAISE EXCEPTION 'Accepted source manifest is immutable' USING ERRCODE='SH409'; END IF;
          RETURN NEW;
        END IF;
        IF NEW.source_manifest IS NOT NULL THEN
          PERFORM ${s}.shorts_accepted_source_refs(NEW.network,NEW.contract,NEW.id,NEW.creator,NEW.input,NEW.source_manifest);
        END IF;
        RETURN NEW;
      END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_accepted_manifest_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_accepted_manifest_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_ingestion
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_accepted_manifest_guard();
    CREATE TRIGGER shorts_accepted_manifest_truncate BEFORE TRUNCATE ON ${s}.shorts_ingestion
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_accepted_manifest_guard();`);
    await this.epoch(db, false);
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query('LOCK TABLE shorts_ingestion IN ACCESS EXCLUSIVE MODE');
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_ingestion WHERE source_manifest IS NOT NULL) AS used',
    );
    if (used)
      throw new Error('Preserve accepted source manifests before rollback');
    await this.epoch(db, true);
    await db.query(`DROP TRIGGER shorts_accepted_manifest_guard ON shorts_ingestion;
      DROP TRIGGER shorts_accepted_manifest_truncate ON shorts_ingestion;
      DROP FUNCTION shorts_accepted_manifest_guard();
      DROP FUNCTION shorts_accepted_source_refs(text,text,text,text,jsonb,text);
      ALTER TABLE shorts_ingestion DROP COLUMN source_manifest`);
  }
}
