import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

export class ShortsMediaIngestion1791763200001 extends FeatureMigration {
  readonly steps = {
    ShortsMetadata: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE shorts_runtime (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      source_hash char(64) NOT NULL,
      max_pending integer NOT NULL CHECK(max_pending BETWEEN 1 AND 10000),
      max_creator_pending integer NOT NULL CHECK(max_creator_pending BETWEEN 1 AND max_pending),
      PRIMARY KEY(network,contract)
    )`);
        await runner.query(`CREATE TABLE shorts_content (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      id varchar(80) NOT NULL, creator varchar(100) NOT NULL,
      created_at bigint NOT NULL CHECK(created_at >= 0),
      revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
      body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      CHECK(body ?& ARRAY['id','creator'] AND body->>'id'=id AND body->>'creator'=creator)
    )`);
        await runner.query(`CREATE INDEX shorts_content_page ON shorts_content(network,contract,created_at DESC,id DESC);
      CREATE INDEX shorts_content_creator_page ON shorts_content(network,contract,creator,created_at DESC,id DESC)`);
        await runner.query(`CREATE TABLE shorts_ingestion (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      id varchar(80) NOT NULL, creator varchar(100) NOT NULL,
      input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND input->>'processingProfile' IS NOT DISTINCT FROM 'original-h264-v1'),
      status varchar(16) NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed','cancelled')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
      fence bigint NOT NULL DEFAULT 0 CHECK(fence >= 0),
      lease_token uuid, lease_until timestamptz,
      error_code varchar(32), result_id varchar(80),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      FOREIGN KEY(network,contract,result_id) REFERENCES shorts_content(network,contract,id),
      CHECK(CASE WHEN status='processing' THEN lease_token IS NOT NULL AND lease_until IS NOT NULL
        ELSE lease_token IS NULL AND lease_until IS NULL END),
      CHECK((status='ready')=(result_id IS NOT NULL))
    )`);
        await runner.query(`CREATE INDEX shorts_ingestion_pending ON shorts_ingestion(network,contract,created_at,id)
      WHERE status IN ('queued','processing');
      CREATE INDEX shorts_ingestion_creator ON shorts_ingestion(network,contract,creator,status);
      CREATE INDEX shorts_ingestion_expired ON shorts_ingestion(network,contract,lease_until)
      WHERE status='processing'`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP TABLE shorts_ingestion');
        await runner.query('DROP TABLE shorts_content');
        await runner.query('DROP TABLE shorts_runtime');
      },
    },

    ShortsSessions: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE shorts_auth_scopes (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, origin varchar(256) NOT NULL,
      PRIMARY KEY(network,contract,origin)
    )`);
        await runner.query(`CREATE TABLE shorts_auth_challenges (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, origin varchar(256) NOT NULL,
      id char(48) NOT NULL, address varchar(100) NOT NULL, message varchar(2048) NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY(network,contract,origin,id),
      FOREIGN KEY(network,contract,origin) REFERENCES shorts_auth_scopes(network,contract,origin)
    )`);
        await runner.query(`CREATE INDEX shorts_auth_challenges_expiry ON shorts_auth_challenges(expires_at);
      CREATE INDEX shorts_auth_challenges_address ON shorts_auth_challenges(network,contract,origin,address)`);
        await runner.query(`CREATE TABLE shorts_auth_sessions (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, origin varchar(256) NOT NULL,
      token_hash char(64) NOT NULL, address varchar(100) NOT NULL, expires_at timestamptz NOT NULL,
      PRIMARY KEY(network,contract,origin,token_hash),
      FOREIGN KEY(network,contract,origin) REFERENCES shorts_auth_scopes(network,contract,origin)
    )`);
        await runner.query(`CREATE INDEX shorts_auth_sessions_expiry ON shorts_auth_sessions(expires_at);
      CREATE INDEX shorts_auth_sessions_address ON shorts_auth_sessions(network,contract,origin,address)`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP TABLE shorts_auth_sessions');
        await runner.query('DROP TABLE shorts_auth_challenges');
        await runner.query('DROP TABLE shorts_auth_scopes');
      },
    },

    ShortsUploads: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE shorts_upload_sessions (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      id varchar(80) NOT NULL, creator varchar(100) NOT NULL,
      input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND input->>'processingProfile' IS NOT DISTINCT FROM 'original-h264-v1'),
      state varchar(16) NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','sealed','enqueued')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    )`);
        await runner.query(`CREATE TABLE shorts_upload_parts (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, upload_id varchar(80) NOT NULL,
      part integer NOT NULL CHECK(part BETWEEN 0 AND 39),
      object_ref jsonb NOT NULL CHECK(jsonb_typeof(object_ref)='object'),
      PRIMARY KEY(network,contract,upload_id,part),
      FOREIGN KEY(network,contract,upload_id) REFERENCES shorts_upload_sessions(network,contract,id)
    )`);
        await runner.query(`CREATE TABLE shorts_upload_admission (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, upload_id varchar(80) NOT NULL,
      creator varchar(100) NOT NULL, bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 41943040),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,upload_id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    )`);
        await runner.query(`CREATE INDEX shorts_upload_admission_time ON shorts_upload_admission(network,contract,created_at);
      CREATE INDEX shorts_upload_sessions_expiry ON shorts_upload_sessions(network,contract,expires_at)`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP TABLE shorts_upload_admission');
        await runner.query('DROP TABLE shorts_upload_parts');
        await runner.query('DROP TABLE shorts_upload_sessions');
      },
    },

    ShortsWorkers: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE shorts_media_workers (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id uuid NOT NULL,
      heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    )`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP TABLE shorts_media_workers');
      },
    },

    /** Workers receive EXECUTE on this boundary, never grants on application tables. */
    ShortsWorkerAuthority: {
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
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP FUNCTION shorts_media_worker(text,jsonb)');
        await runner.query('DROP TABLE shorts_worker_principals');
        await runner.query(
          'ALTER TABLE shorts_ingestion DROP COLUMN lease_principal',
        );
        await runner.query(
          'ALTER TABLE shorts_media_workers DROP COLUMN principal',
        );
      },
    },

    ShortsStreamingOutbox: {
      async up(runner: QueryRunner): Promise<void> {
        const [{ schema }] = await runner.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await runner.query(`CREATE TABLE ${s}.shorts_stream_jobs (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      generation bigint NOT NULL DEFAULT 1 CHECK(generation>0), cid text NOT NULL,
      ready boolean NOT NULL DEFAULT false,
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 16),
      next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_token uuid, lease_until timestamptz,
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract,id) REFERENCES ${s}.shorts_content(network,contract,id) ON DELETE CASCADE,
      CHECK((lease_token IS NULL)=(lease_until IS NULL)),
      CHECK(NOT ready OR lease_token IS NULL)
    )`);
        await runner.query(`CREATE INDEX shorts_stream_jobs_pending ON ${s}.shorts_stream_jobs(network,contract,next_at,id)
      WHERE NOT ready`);
        // Enqueue in the same transaction as publication, including imports and recovery.
        // The dispatcher and the streaming catalog still enforce the current policy.
        await runner.query(`CREATE FUNCTION ${s}.shorts_schedule_stream() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $stream$
      BEGIN
        IF NEW.body->>'publication' IS DISTINCT FROM 'published' THEN
          DELETE FROM ${s}.shorts_stream_jobs WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.id;
          RETURN NEW;
        END IF;
        IF TG_OP='UPDATE' AND
          jsonb_build_array(OLD.body->'cid',OLD.body->'bytes',OLD.body->'creator',OLD.body->'publication',
            OLD.body->'moderation',OLD.body->'safety',OLD.body->'visualReviewHash') IS NOT DISTINCT FROM
          jsonb_build_array(NEW.body->'cid',NEW.body->'bytes',NEW.body->'creator',NEW.body->'publication',
            NEW.body->'moderation',NEW.body->'safety',NEW.body->'visualReviewHash') THEN
          RETURN NEW;
        END IF;
        INSERT INTO ${s}.shorts_stream_jobs(network,contract,id,cid)
          VALUES(NEW.network,NEW.contract,NEW.id,NEW.body->>'cid')
          ON CONFLICT(network,contract,id) DO UPDATE SET
            generation=${s}.shorts_stream_jobs.generation+1,cid=excluded.cid,ready=false,
            attempts=0,next_at=clock_timestamp(),lease_token=NULL,lease_until=NULL;
        RETURN NEW;
      END $stream$`);
        await runner.query(`REVOKE ALL ON FUNCTION ${s}.shorts_schedule_stream() FROM PUBLIC;
      CREATE TRIGGER shorts_schedule_stream AFTER INSERT OR UPDATE OF body ON ${s}.shorts_content
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_schedule_stream()`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query(
          'DROP TRIGGER shorts_schedule_stream ON shorts_content',
        );
        await runner.query('DROP FUNCTION shorts_schedule_stream()');
        await runner.query('DROP TABLE shorts_stream_jobs');
      },
    },
  };
}
