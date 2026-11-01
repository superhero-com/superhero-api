import { MigrationInterface, QueryRunner } from 'typeorm';

/** Workers receive EXECUTE on this boundary, never grants on application tables. */
export class ShortsWorkerAuthority1791763204000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await runner.query(`CREATE TABLE ${s}.shorts_worker_principals (
      role_oid oid PRIMARY KEY, role_name name NOT NULL UNIQUE,
      network varchar(32) NOT NULL CHECK(network='ae_uat'), contract varchar(100) NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_runtime(network,contract)
    )`);
    await runner.query(`ALTER TABLE ${s}.shorts_ingestion ADD COLUMN lease_principal oid;
      ALTER TABLE ${s}.shorts_media_workers ADD COLUMN principal oid`);
    await runner.query(`CREATE FUNCTION ${s}.shorts_media_worker(action text, payload jsonb)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp AS $worker$
    DECLARE
      binding ${s}.shorts_worker_principals%ROWTYPE;
      login pg_catalog.pg_roles%ROWTYPE;
      job ${s}.shorts_ingestion%ROWTYPE;
      runtime ${s}.shorts_runtime%ROWTYPE;
      output jsonb; file jsonb; ref jsonb; body jsonb;
      lease_ms integer; file_total bigint := 0; names text[] := ARRAY[]::text[];
      object_prefix text; changed integer;
    BEGIN
      IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR octet_length(payload::text)>262144 THEN
        RAISE EXCEPTION 'Invalid worker request' USING ERRCODE='SH400';
      END IF;
      SELECT * INTO login FROM pg_catalog.pg_roles WHERE rolname=session_user;
      SELECT * INTO binding FROM ${s}.shorts_worker_principals
        WHERE role_oid=login.oid AND role_name=session_user AND enabled;
      IF NOT FOUND OR NOT login.rolcanlogin OR login.rolsuper OR login.rolcreaterole OR login.rolcreatedb
        OR login.rolreplication OR login.rolbypassrls
        OR EXISTS(SELECT FROM pg_catalog.pg_auth_members WHERE member=login.oid) THEN
        RAISE EXCEPTION 'A dedicated worker login is required' USING ERRCODE='SH401';
      END IF;
      -- Fail closed on accidental broad grants, ownership or PUBLIC privileges.
      -- All names in this definer body are qualified; temporary objects cannot shadow them.
      IF EXISTS(SELECT FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND pg_catalog.has_schema_privilege(login.oid,n.oid,'CREATE'))
        OR pg_catalog.has_database_privilege(login.oid,current_database(),'CREATE')
        OR EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
          AND pg_catalog.has_table_privilege(login.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
        OR EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
          AND p.oid<>'${s.replaceAll("'", "''")}.shorts_media_worker(text,jsonb)'::regprocedure
          AND pg_catalog.has_function_privilege(login.oid,p.oid,'EXECUTE')) THEN
        RAISE EXCEPTION 'Worker login has excessive database privileges' USING ERRCODE='SH401';
      END IF;
      SELECT * INTO runtime FROM ${s}.shorts_runtime
        WHERE network=binding.network AND contract=binding.contract;
      IF payload->>'network' IS DISTINCT FROM binding.network OR payload->>'contract' IS DISTINCT FROM binding.contract
        OR payload->>'sourceHash' IS DISTINCT FROM runtime.source_hash::text THEN
        RAISE EXCEPTION 'Worker deployment does not match' USING ERRCODE='SH401';
      END IF;
      IF action='verify' THEN RETURN '{}'::jsonb; END IF;
      IF action IN ('pulse','stop') THEN
        IF action='stop' THEN
          DELETE FROM ${s}.shorts_media_workers WHERE network=binding.network AND contract=binding.contract
            AND id=(payload->>'workerId')::uuid AND shorts_media_workers.principal=login.oid;
        ELSE
          INSERT INTO ${s}.shorts_media_workers(network,contract,id,principal)
            VALUES(binding.network,binding.contract,(payload->>'workerId')::uuid,login.oid)
            ON CONFLICT(network,contract,id) DO UPDATE SET heartbeat_at=clock_timestamp()
            WHERE ${s}.shorts_media_workers.principal=login.oid;
          GET DIAGNOSTICS changed=ROW_COUNT;
          IF changed<>1 THEN RAISE EXCEPTION 'Worker identity belongs to another login' USING ERRCODE='SH409'; END IF;
          DELETE FROM ${s}.shorts_media_workers WHERE network=binding.network AND contract=binding.contract
            AND heartbeat_at<clock_timestamp()-interval '1 day';
        END IF;
        RETURN '{}'::jsonb;
      END IF;
      IF action IN ('claim','heartbeat') THEN
        lease_ms=(payload->>'leaseMs')::integer;
        IF lease_ms IS NULL OR lease_ms NOT BETWEEN 1000 AND 300000 THEN
          RAISE EXCEPTION 'Invalid worker lease' USING ERRCODE='SH400';
        END IF;
      END IF;
      IF action='claim' THEN
        UPDATE ${s}.shorts_ingestion SET status='failed',lease_token=NULL,lease_until=NULL,lease_principal=NULL,
          error_code='attempts_exhausted',updated_at=clock_timestamp()
          WHERE (network,contract,id) IN (SELECT network,contract,id FROM ${s}.shorts_ingestion
            WHERE network=binding.network AND contract=binding.contract AND status='processing'
            AND lease_until<=clock_timestamp() AND attempts>=3 ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED);
        WITH candidate AS (
          SELECT id FROM ${s}.shorts_ingestion WHERE network=binding.network AND contract=binding.contract
            AND attempts<3 AND (status='queued' OR (status='processing' AND lease_until<=clock_timestamp()))
            ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) UPDATE ${s}.shorts_ingestion j SET status='processing',attempts=attempts+1,fence=fence+1,
          lease_token=gen_random_uuid(),lease_principal=login.oid,
          lease_until=clock_timestamp()+lease_ms*interval '1 millisecond',updated_at=clock_timestamp(),error_code=NULL
          FROM candidate c WHERE j.network=binding.network AND j.contract=binding.contract AND j.id=c.id RETURNING j.* INTO job;
        IF NOT FOUND THEN RETURN NULL; END IF;
        RETURN to_jsonb(job)||jsonb_build_object('fence',job.fence::text);
      END IF;
      IF action NOT IN ('heartbeat','fail','complete') OR action IS NULL THEN
        RAISE EXCEPTION 'Unknown worker operation' USING ERRCODE='SH400';
      END IF;
      -- Check expiry after acquiring the row lock, not only in a pre-wait predicate.
      SELECT * INTO job FROM ${s}.shorts_ingestion WHERE network=binding.network AND contract=binding.contract
        AND id=payload->>'id' FOR UPDATE;
      IF NOT FOUND OR job.status<>'processing' OR job.lease_principal IS DISTINCT FROM login.oid
        OR job.fence::text IS DISTINCT FROM payload->>'fence'
        OR job.lease_token::text IS DISTINCT FROM payload->>'leaseToken' OR job.lease_until<=clock_timestamp() THEN
        IF action IN ('heartbeat','fail') THEN RETURN 'false'::jsonb; END IF;
        RAISE EXCEPTION 'Preparation claim expired or was replaced' USING ERRCODE='SH409';
      END IF;
      IF action='heartbeat' THEN
        UPDATE ${s}.shorts_ingestion SET lease_until=clock_timestamp()+lease_ms*interval '1 millisecond',updated_at=clock_timestamp()
          WHERE network=binding.network AND contract=binding.contract AND id=job.id;
        RETURN 'true'::jsonb;
      END IF;
      IF action='fail' THEN
        UPDATE ${s}.shorts_ingestion SET status='failed',lease_token=NULL,lease_until=NULL,lease_principal=NULL,
          error_code='preparation_failed',updated_at=clock_timestamp()
          WHERE network=binding.network AND contract=binding.contract AND id=job.id;
        RETURN 'true'::jsonb;
      END IF;
      output=payload->'record';
      IF jsonb_typeof(output) IS DISTINCT FROM 'object'
        OR output->>'id' IS DISTINCT FROM job.id OR output->>'creator' IS DISTINCT FROM job.creator
        OR output->>'moderation' IS NULL OR output->>'moderation' NOT IN ('pending','rejected')
        OR output ? 'publication' OR output ? 'withdrawn'
        OR output->>'cid' IS NULL OR output->>'cid' !~ '^b[a-z2-7]{10,120}$'
        OR jsonb_typeof(output->'files') IS DISTINCT FROM 'array'
        OR jsonb_typeof(output->'privateMedia'->'files') IS DISTINCT FROM 'object'
        OR output->'privateMedia'->'version' IS DISTINCT FROM '1'::jsonb
        OR output->'privateMedia'->>'fence' IS DISTINCT FROM job.fence::text
        OR output->'privateMedia'->'source' IS DISTINCT FROM job.input
        OR job.input->'manifest' IS NULL
        OR jsonb_typeof(output->'safety') IS DISTINCT FROM 'object'
        OR output->'safety'->>'status' IS NULL OR output->'safety'->>'status' NOT IN ('no_flags','blocked','review','error')
        OR jsonb_typeof(output->'duration') IS DISTINCT FROM 'number' OR (output->>'duration')::numeric NOT BETWEEN 2 AND 60
        OR jsonb_typeof(output->'bytes') IS DISTINCT FROM 'number' OR (output->>'bytes')::bigint NOT BETWEEN 1 AND 67108864 THEN
        RAISE EXCEPTION 'Invalid private prepared draft' USING ERRCODE='SH400';
      END IF;
      object_prefix=split_part(job.input->>'objectKey','/'||job.id||'/',1)||'/'||job.id||'/attempt/'||job.fence::text||'/';
      IF jsonb_array_length(output->'files') NOT BETWEEN 3 AND 4 THEN
        RAISE EXCEPTION 'Invalid prepared package' USING ERRCODE='SH400';
      END IF;
      FOR file IN SELECT value FROM jsonb_array_elements(output->'files') LOOP
        ref=output->'privateMedia'->'files'->(file->>'name');
        IF file->>'name' IS NULL OR file->>'name' NOT IN ('video.mp4','poster.jpg','manifest.json','captions.vtt')
          OR file->>'name'=ANY(names) OR file->>'sha256' IS NULL OR file->>'sha256' !~ '^[a-f0-9]{64}$'
          OR jsonb_typeof(file->'bytes') IS DISTINCT FROM 'number' OR (file->>'bytes')::bigint NOT BETWEEN 1 AND 67108864
          OR jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref->'bytes' IS DISTINCT FROM file->'bytes'
          OR ref->'sha256' IS DISTINCT FROM file->'sha256' OR ref->>'keyId' IS NULL OR ref->>'keyId' !~ '^[a-zA-Z0-9_-]{1,32}$'
          OR ref->>'key' IS DISTINCT FROM object_prefix||replace(file->>'name','.','-')||'/'||(ref->>'keyId')||'/'||(ref->>'sha256') THEN
          RAISE EXCEPTION 'Invalid prepared object reference' USING ERRCODE='SH400';
        END IF;
        names=array_append(names,file->>'name'); file_total=file_total+(file->>'bytes')::bigint;
      END LOOP;
      IF NOT names @> ARRAY['video.mp4','poster.jpg','manifest.json'] OR file_total<>(output->>'bytes')::bigint
        OR (SELECT count(*) FROM jsonb_object_keys(output->'privateMedia'->'files'))<>cardinality(names)
        OR ('captions.vtt'=ANY(names)) IS DISTINCT FROM (coalesce(job.input->'details'->>'captions','')<>'') THEN
        RAISE EXCEPTION 'Prepared files do not match' USING ERRCODE='SH400';
      END IF;
      -- Construct the stored record explicitly. Worker-controlled approval, counters,
      -- chain state or alternate identity fields are never copied into content.
      body=jsonb_build_object('id',job.id,'creator',job.creator,'title',btrim(job.input->>'title'),'topic',job.input->>'topic',
        'createdAt',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,
        'cid',output->'cid','bytes',output->'bytes','duration',output->'duration','files',output->'files',
        'safety',output->'safety','classification',output->'classification','privateMedia',output->'privateMedia',
        'description',coalesce(job.input->'details'->>'description',''),'language',coalesce(job.input->'details'->>'language','und'),
        'synthetic',coalesce(job.input->'details'->'synthetic'='true'::jsonb,false),
        'sponsored',coalesce(job.input->'details'->'sponsored'='true'::jsonb,false),
        'captions','captions.vtt'=ANY(names),'moderation',CASE WHEN output->'safety'->>'status'='blocked' THEN 'rejected' ELSE 'pending' END,
        'reviewReason',output->'safety'->'reason','reports',0,'views','[]'::jsonb);
      INSERT INTO ${s}.shorts_content(network,contract,id,creator,created_at,body)
        VALUES(binding.network,binding.contract,job.id,job.creator,(body->>'createdAt')::bigint,body);
      UPDATE ${s}.shorts_ingestion SET status='ready',result_id=id,lease_token=NULL,lease_until=NULL,lease_principal=NULL,
        updated_at=clock_timestamp(),error_code=NULL WHERE network=binding.network AND contract=binding.contract AND id=job.id
        AND lease_until>clock_timestamp();
      GET DIAGNOSTICS changed=ROW_COUNT;
      IF changed<>1 THEN RAISE EXCEPTION 'Preparation lease expired before commit' USING ERRCODE='SH409'; END IF;
      RETURN jsonb_build_object('record',body,'revision','1');
    END $worker$`);
    await runner.query(`REVOKE ALL ON FUNCTION ${s}.shorts_media_worker(text,jsonb) FROM PUBLIC;
      REVOKE ALL ON TABLE ${s}.shorts_worker_principals FROM PUBLIC`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP FUNCTION shorts_media_worker(text,jsonb)');
    await runner.query('DROP TABLE shorts_worker_principals');
    await runner.query(
      'ALTER TABLE shorts_ingestion DROP COLUMN lease_principal',
    );
    await runner.query(
      'ALTER TABLE shorts_media_workers DROP COLUMN principal',
    );
  }
}
