import { MigrationInterface, QueryRunner } from 'typeorm';

/** Verified private-input closure; physical removal requires separate authority. */
export class ShortsPrivateInputRetirement1793491200000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_private_input_retirements (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,short_id varchar(80) NOT NULL,
      source_key char(64) NOT NULL,operation_id uuid NOT NULL,resource_id varchar(80) NOT NULL,
      root_hash char(64) NOT NULL CHECK(root_hash ~ '^[a-f0-9]{64}$'),reference_epoch bigint NOT NULL CHECK(reference_epoch>=0),
      source_manifest text NOT NULL CHECK(octet_length(source_manifest) BETWEEN 1 AND 98304),
      objects jsonb NOT NULL CHECK(jsonb_typeof(objects)='array' AND jsonb_array_length(objects) BETWEEN 1 AND 256),
      retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,short_id,source_key),UNIQUE(network,contract,short_id,operation_id),
      FOREIGN KEY(network,contract,short_id,source_key)
        REFERENCES ${s}.shorts_delivery_input_retirements(network,contract,short_id,source_key)
    );
    CREATE INDEX shorts_private_retirement_resource ON ${s}.shorts_private_input_retirements(network,contract,resource_id);
    REVOKE ALL ON ${s}.shorts_private_input_retirements FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_input_snapshot(net text,ctr text,sid text,skey text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $snapshot$
      DECLARE receipt record; original jsonb; content jsonb; job record; upload jsonb; staged jsonb;
        refs jsonb; source_state jsonb; epoch bigint;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'Private input retirement requires READ COMMITTED' USING ERRCODE='SH400';
        END IF;
        SELECT body INTO original FROM ${s}.shorts_content WHERE network=net AND contract=ctr AND id=sid FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Original is missing' USING ERRCODE='SH409'; END IF;
        SELECT * INTO receipt FROM ${s}.shorts_delivery_input_retirements
          WHERE network=net AND contract=ctr AND short_id=sid AND source_key=skey;
        IF NOT FOUND THEN RAISE EXCEPTION 'Retire encoded inputs first' USING ERRCODE='SH409'; END IF;
        -- Reuse the current eligibility guard, including holds and renewed rollback windows.
        -- The existing primary key makes this a no-op: retirement history stays unchanged.
        INSERT INTO ${s}.shorts_delivery_input_retirements
          (network,contract,short_id,source_key,operation_id,input_cid,generation_job_id)
          VALUES(net,ctr,sid,skey,receipt.operation_id,receipt.input_cid,receipt.generation_job_id) ON CONFLICT DO NOTHING;
        SELECT revision INTO epoch FROM ${s}.shorts_private_storage_epochs WHERE network=net AND contract=ctr FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Private reference epoch missing' USING ERRCODE='SH409'; END IF;
        content=original;
        IF receipt.generation_job_id<>sid THEN
          SELECT body INTO content FROM ${s}.shorts_delivery_generations
            WHERE network=net AND contract=ctr AND short_id=sid AND job_id=receipt.generation_job_id;
        END IF;
        SELECT * INTO job FROM ${s}.shorts_ingestion WHERE network=net AND contract=ctr AND id=receipt.generation_job_id;
        IF NOT FOUND OR job.status<>'ready' OR content->>'id' IS DISTINCT FROM job.id
          OR content->>'creator' IS DISTINCT FROM job.creator
          OR content#>'{privateMedia,source}' IS DISTINCT FROM job.input
          OR content#>>'{privateMedia,fence}' IS DISTINCT FROM job.fence::text
          OR job.input->>'processingProfile' IS DISTINCT FROM 'original-h264-v1'
          OR job.input->'objectKey' IS DISTINCT FROM job.input#>'{manifest,key}'
          OR (job.input ? 'acceptedMaxBytes' AND (jsonb_typeof(job.input->'acceptedMaxBytes') IS DISTINCT FROM 'number'
            OR job.input->>'acceptedMaxBytes' !~ '^[1-9][0-9]{0,8}$'))
          OR NOT COALESCE((job.input->>'acceptedMaxBytes')::bigint BETWEEN (job.input->>'bytes')::bigint AND 100000000,
            NOT job.input ? 'acceptedMaxBytes') THEN
          RAISE EXCEPTION 'Private source is not a completed original' USING ERRCODE='SH409';
        END IF;
        PERFORM ${s}.shorts_validate_original(content);
        SELECT jsonb_build_object('state',state,'parts',COALESCE(to_jsonb(u)->'direct_parts','{}'::jsonb)) INTO upload
          FROM ${s}.shorts_upload_sessions u WHERE network=net AND contract=ctr AND id=job.id;
        IF upload IS NOT NULL AND upload->>'state'<>'enqueued' THEN
          RAISE EXCEPTION 'Upload still retains private inputs' USING ERRCODE='SH409';
        END IF;
        SELECT jsonb_build_object('state',state,'manifest',manifest) INTO staged FROM ${s}.shorts_delivery_staging
          WHERE network=net AND contract=ctr AND job_id=job.id;
        IF staged IS NOT NULL AND staged->>'state'<>'ready' THEN
          RAISE EXCEPTION 'Restaging still retains private inputs' USING ERRCODE='SH409';
        END IF;
        SELECT COALESCE(jsonb_agg(ref ORDER BY ref::text),'[]'::jsonb) INTO refs FROM (
          SELECT value AS ref FROM jsonb_each(content#>'{privateMedia,files}')
          UNION ALL SELECT job.input->'manifest'
          UNION ALL SELECT object_ref FROM ${s}.shorts_upload_parts WHERE network=net AND contract=ctr AND upload_id=job.id
          UNION ALL SELECT value->'object' FROM jsonb_each(COALESCE(upload->'parts','{}'::jsonb))
        ) declared;
        source_state=jsonb_build_object('source',content->'privateMedia','job',jsonb_build_array(job.id,job.creator,job.input,job.status,job.fence),
          'upload',upload,'staged',staged,'refs',refs);
        RETURN jsonb_build_object('resourceId',job.id,'record',content,'refs',refs,'epoch',epoch::text,
          'rootHash',encode(sha256(convert_to(source_state::text,'UTF8')),'hex'),'staged',staged);
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Invalid private source state' USING ERRCODE='SH400';
      END $snapshot$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_input_snapshot(text,text,text,text) FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_input_retirement_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      DECLARE current jsonb; source jsonb; document jsonb; expected jsonb; part record; ref jsonb; total bigint; prefix text;
      BEGIN
        IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Private retirement history is immutable' USING ERRCODE='SH409'; END IF;
        current=${s}.shorts_private_input_snapshot(NEW.network,NEW.contract,NEW.short_id,NEW.source_key);
        IF NEW.root_hash IS DISTINCT FROM current->>'rootHash' THEN
          RAISE EXCEPTION 'Private references changed during verification' USING ERRCODE='SH409';
        END IF;
        source=current#>'{record,privateMedia,source}';
        prefix=split_part(source#>>'{manifest,key}','/',1)||'/'||encode(sha256(convert_to(
          '['||to_json(NEW.network)::text||','||to_json(NEW.contract)::text||']','UTF8')),'hex')||'/';
        IF octet_length(NEW.source_manifest) IS DISTINCT FROM (source#>>'{manifest,bytes}')::integer
          OR encode(sha256(convert_to(NEW.source_manifest,'UTF8')),'hex') IS DISTINCT FROM source#>>'{manifest,sha256}'
          OR (current->'staged'<>'null'::jsonb AND current#>>'{staged,manifest}' IS DISTINCT FROM NEW.source_manifest) THEN
          RAISE EXCEPTION 'Source manifest identity mismatch' USING ERRCODE='SH400';
        END IF;
        document=NEW.source_manifest::jsonb;
        IF document->'version' IS DISTINCT FROM '1'::jsonb OR document->>'id' IS DISTINCT FROM current->>'resourceId'
          OR document->'creator' IS DISTINCT FROM current#>'{record,creator}' OR document->'bytes' IS DISTINCT FROM source->'bytes'
          OR document->'sha256' IS DISTINCT FROM source->'sha256' OR jsonb_typeof(document->'parts') IS DISTINCT FROM 'array'
          OR jsonb_array_length(document->'parts')<>ceil((source->>'bytes')::numeric/1048576) THEN
          RAISE EXCEPTION 'Invalid private source manifest' USING ERRCODE='SH400';
        END IF;
        expected=current->'refs'; total=(source->>'bytes')::bigint;
        FOR part IN SELECT value,ordinality FROM jsonb_array_elements(document->'parts') WITH ORDINALITY LOOP
          IF part.value->'index' IS DISTINCT FROM to_jsonb(part.ordinality-1)
            OR part.value#>'{object,bytes}' IS DISTINCT FROM to_jsonb(least(1048576::bigint,total-(part.ordinality-1)*1048576)) THEN
            RAISE EXCEPTION 'Invalid private source parts' USING ERRCODE='SH400';
          END IF;
          expected=expected||jsonb_build_array(part.value->'object');
        END LOOP;
        FOR ref IN SELECT value FROM jsonb_array_elements(expected) LOOP
          IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref IS DISTINCT FROM jsonb_build_object(
              'key',ref->'key','keyId',ref->'keyId','bytes',ref->'bytes','sha256',ref->'sha256')
            OR jsonb_typeof(ref->'key') IS DISTINCT FROM 'string' OR octet_length(ref->>'key') NOT BETWEEN 1 AND 512
            OR ref->>'key' !~ '^[a-zA-Z0-9_/-]+$' OR strpos(ref->>'key','//')>0
            OR left(ref->>'key',length(prefix)) IS DISTINCT FROM prefix
            OR jsonb_typeof(ref->'keyId') IS DISTINCT FROM 'string' OR jsonb_typeof(ref->'sha256') IS DISTINCT FROM 'string'
            OR COALESCE(ref->>'keyId','') !~ '^[a-zA-Z0-9_-]{1,32}$' OR COALESCE(ref->>'sha256','') !~ '^[a-f0-9]{64}$'
            OR right(ref->>'key',length(ref->>'keyId')+length(ref->>'sha256')+2)
              IS DISTINCT FROM '/'||(ref->>'keyId')||'/'||(ref->>'sha256')
            OR jsonb_typeof(ref->'bytes') IS DISTINCT FROM 'number' OR (ref->>'bytes') !~ '^[1-9][0-9]{0,8}$'
            OR (ref->>'bytes')::bigint>100000000 THEN
            RAISE EXCEPTION 'Invalid private object reference' USING ERRCODE='SH400';
          END IF;
        END LOOP;
        SELECT jsonb_agg(unique_refs.ref ORDER BY unique_refs.ref->>'key') INTO NEW.objects
          FROM (SELECT DISTINCT value AS ref FROM jsonb_array_elements(expected)) unique_refs;
        IF jsonb_array_length(NEW.objects)>256 OR (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(NEW.objects))<>jsonb_array_length(NEW.objects) THEN
          RAISE EXCEPTION 'Conflicting or excessive private references' USING ERRCODE='SH400';
        END IF;
        NEW.resource_id=current->>'resourceId'; NEW.reference_epoch=(current->>'epoch')::bigint; NEW.retired_at=clock_timestamp(); RETURN NEW;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Invalid private retirement data' USING ERRCODE='SH400';
      END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_input_retirement_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_private_input_retirement_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_private_input_retirements
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_input_retirement_guard();
    CREATE TRIGGER shorts_private_input_retirement_truncate BEFORE TRUNCATE ON ${s}.shorts_private_input_retirements
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_private_input_retirement_guard();
    CREATE TRIGGER shorts_private_reference_epoch AFTER INSERT ON ${s}.shorts_private_input_retirements
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_reference_epoch();`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_private_input_retirements IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_private_input_retirements) AS used',
    );
    if (used)
      throw new Error(
        'Preserve private input retirement history before rollback',
      );
    await db.query(`DROP TABLE shorts_private_input_retirements;
      DROP FUNCTION shorts_private_input_retirement_guard();
      DROP FUNCTION shorts_private_input_snapshot(text,text,text,text)`);
  }
}
