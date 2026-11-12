import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

const shortsPrivateVersionCleanupSources = [
  'shorts_content',
  'shorts_ingestion',
  'shorts_upload_sessions',
  'shorts_upload_parts',
  'shorts_retention_holds',
  'shorts_delivery_packages',
  'shorts_delivery_generations',
  'shorts_delivery_staging',
];

async function shortsAcceptedManifestsEpoch(db: QueryRunner, reverse: boolean) {
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

const shortsPrivateReferenceBarriersSources = [
  'shorts_content',
  'shorts_ingestion',
  'shorts_upload_sessions',
  'shorts_upload_parts',
  'shorts_delivery_generations',
  'shorts_delivery_staging',
];

async function shortsPrivateReferenceBarriersWriters(
  db: QueryRunner,
  s: string,
) {
  await db.query(`CREATE FUNCTION ${s}.shorts_private_direct_refs(tbl text,row_body jsonb) RETURNS jsonb
      LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $refs$
      DECLARE refs jsonb='[]';
      BEGIN
        IF tbl IN ('shorts_content','shorts_delivery_generations') THEN
          SELECT COALESCE(jsonb_agg(value),'[]') INTO refs FROM jsonb_each(row_body#>'{body,privateMedia,files}');
          refs=refs||jsonb_build_array(row_body#>'{body,privateMedia,source,manifest}');
        ELSIF tbl='shorts_ingestion' THEN refs=jsonb_build_array(row_body#>'{input,manifest}');
        ELSIF tbl='shorts_upload_parts' THEN refs=jsonb_build_array(row_body->'object_ref');
        ELSIF tbl='shorts_upload_sessions' THEN
          SELECT COALESCE(jsonb_agg(value->'object'),'[]') INTO refs FROM jsonb_each(row_body->'direct_parts');
        ELSIF tbl='shorts_delivery_staging' AND row_body->>'manifest' IS NOT NULL THEN
          SELECT COALESCE(jsonb_agg(value->'object'),'[]') INTO refs FROM jsonb_array_elements((row_body->>'manifest')::jsonb->'parts');
        END IF;
        RETURN refs;
      END $refs$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_direct_refs(text,jsonb) FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_reference_barrier() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $writer$
      DECLARE before_body jsonb; after_body jsonb; before_refs jsonb; after_refs jsonb; source jsonb; old_source jsonb; job record; resource text;
      BEGIN
        after_body=to_jsonb(NEW); before_body=to_jsonb(OLD);
        -- The existing AFTER epoch trigger has already serialized this writer. Lock again
        -- so explicit SET CONSTRAINTS and concurrent writers have the same boundary.
        PERFORM 1 FROM ${s}.shorts_private_storage_epochs WHERE network=after_body->>'network' AND contract=after_body->>'contract' FOR UPDATE;
        IF NOT EXISTS(SELECT FROM ${s}.shorts_private_cleanup_scopes WHERE network=after_body->>'network' AND contract=after_body->>'contract') THEN RETURN NEW; END IF;
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cleanup references require READ COMMITTED' USING ERRCODE='SH400'; END IF;
        IF TG_OP='INSERT' OR jsonb_build_array(before_body->'network',before_body->'contract',before_body->'id',before_body->'job_id',before_body->'upload_id') IS DISTINCT FROM
          jsonb_build_array(after_body->'network',after_body->'contract',after_body->'id',after_body->'job_id',after_body->'upload_id') THEN before_body=NULL; END IF;
        before_refs=${s}.shorts_private_direct_refs(TG_TABLE_NAME,before_body);
        after_refs=${s}.shorts_private_direct_refs(TG_TABLE_NAME,after_body);
        IF TG_TABLE_NAME='shorts_ingestion' THEN
          source=after_body->'input'; old_source=before_body->'input'; resource=after_body->>'id';
        ELSIF TG_TABLE_NAME IN ('shorts_content','shorts_delivery_generations') THEN
          source=after_body#>'{body,privateMedia,source}'; old_source=before_body#>'{body,privateMedia,source}'; resource=after_body#>>'{body,id}';
        END IF;
        IF source IS NOT NULL AND (source IS DISTINCT FROM old_source OR
          (TG_TABLE_NAME='shorts_ingestion' AND after_body->'source_manifest' IS DISTINCT FROM before_body->'source_manifest')) THEN
          -- enqueue inserts and binds the document in one transaction; inspect the final row.
          SELECT * INTO job FROM ${s}.shorts_ingestion WHERE network=after_body->>'network' AND contract=after_body->>'contract' AND id=resource;
          IF NOT FOUND OR job.source_manifest IS NULL OR job.input IS DISTINCT FROM source THEN
            RAISE EXCEPTION 'New private source claims require a bound manifest' USING ERRCODE='SH409'; END IF;
          after_refs=after_refs||${s}.shorts_accepted_source_refs(job.network,job.contract,job.id,job.creator,job.input,job.source_manifest);
        END IF;
        IF EXISTS(SELECT FROM jsonb_array_elements(after_refs) r JOIN ${s}.shorts_private_input_barriers b
          ON b.network=after_body->>'network' AND b.contract=after_body->>'contract' AND b.object_key=r.value->>'key' AND b.state<>'cancelled'
          WHERE NOT before_refs @> jsonb_build_array(r.value)) THEN
          RAISE EXCEPTION 'Private object is reserved for retirement' USING ERRCODE='SH409'; END IF;
        RETURN NEW;
      END $writer$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_reference_barrier() FROM PUBLIC;`);
  for (const table of shortsPrivateReferenceBarriersSources)
    await db.query(`CREATE CONSTRAINT TRIGGER shorts_private_reference_barrier AFTER INSERT OR UPDATE ON ${s}.${table}
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_reference_barrier()`);
  await db.query(`CREATE FUNCTION ${s}.shorts_private_version_barrier_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      BEGIN
        PERFORM 1 FROM ${s}.shorts_private_storage_epochs WHERE network=NEW.network AND contract=NEW.contract FOR UPDATE;
        IF EXISTS(SELECT FROM ${s}.shorts_private_input_barriers WHERE network=NEW.network AND contract=NEW.contract
          AND object_key=NEW.object_key AND state<>'cancelled') THEN
          RAISE EXCEPTION 'Private object has an input retirement barrier' USING ERRCODE='SH409'; END IF;
        RETURN NEW;
      END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_version_barrier_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_private_version_z_barrier BEFORE INSERT ON ${s}.shorts_private_version_cleanup
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_version_barrier_guard()`);
}

export class ShortsPrivateMediaCleanup1793232008001 extends FeatureMigration {
  readonly steps = {
    ShortsPrivateVersionCleanup: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = '"' + schema.replaceAll('"', '""') + '"';
        // All additive source readers must exist before cleanup can acquire authority.
        for (const table of shortsPrivateVersionCleanupSources)
          await db.query(
            `LOCK TABLE ${s}.${table} IN SHARE ROW EXCLUSIVE MODE`,
          );
        await db.query(`CREATE TABLE ${s}.shorts_private_storage_epochs (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
      PRIMARY KEY(network,contract),FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_runtime(network,contract));
      INSERT INTO ${s}.shorts_private_storage_epochs(network,contract) SELECT network,contract FROM ${s}.shorts_runtime;
      ALTER TABLE ${s}.shorts_storage_reconciliations ADD COLUMN reference_epoch bigint CHECK(reference_epoch>=0);
      CREATE TABLE ${s}.shorts_private_version_cleanup (
        id uuid PRIMARY KEY,network varchar(32) NOT NULL,contract varchar(100) NOT NULL,
        scan_id uuid NOT NULL,identity char(64) NOT NULL CHECK(identity ~ '^[a-f0-9]{64}$'),
        storage_id char(64) NOT NULL,source_hash char(64) NOT NULL,object_key varchar(512) NOT NULL,
        candidate_version text NOT NULL CHECK(octet_length(candidate_version) BETWEEN 1 AND 1024 AND candidate_version<>'null'),
        key_id varchar(32) NOT NULL,sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
        bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 100000000),
        state varchar(16) NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','removed','cancelled')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(network,contract,scan_id) REFERENCES ${s}.shorts_storage_reconciliations(network,contract,id));
      CREATE UNIQUE INDEX shorts_private_version_pending ON ${s}.shorts_private_version_cleanup(storage_id,object_key) WHERE state='pending';
      CREATE TABLE ${s}.shorts_private_version_events (
        id uuid PRIMARY KEY,operation_id uuid NOT NULL REFERENCES ${s}.shorts_private_version_cleanup(id),
        kind varchar(16) NOT NULL CHECK(kind IN ('issued','uncertain','removed','cancelled')),
        attempt_id uuid REFERENCES ${s}.shorts_private_version_events(id),scan_id uuid,
        reference_epoch bigint,retained_version text CHECK(octet_length(retained_version) BETWEEN 1 AND 1024 AND retained_version<>'null'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE UNIQUE INDEX shorts_private_version_outcome ON ${s}.shorts_private_version_events(attempt_id,kind) WHERE attempt_id IS NOT NULL;
      CREATE INDEX shorts_private_version_history ON ${s}.shorts_private_version_events(operation_id,created_at,id);
      REVOKE ALL ON ${s}.shorts_private_storage_epochs,${s}.shorts_private_version_cleanup,${s}.shorts_private_version_events FROM PUBLIC;`);
        await db.query(`CREATE FUNCTION ${s}.shorts_private_reference_epoch() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $epoch$
      DECLARE old_body jsonb; new_body jsonb; item record;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Private reference writes require READ COMMITTED' USING ERRCODE='SH400'; END IF;
        IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Private reference history cannot be truncated' USING ERRCODE='SH400'; END IF;
        old_body=to_jsonb(OLD); new_body=to_jsonb(NEW);
        IF TG_OP='UPDATE' THEN
          IF TG_TABLE_NAME='shorts_content' THEN
            old_body=jsonb_set(old_body,'{body}',(old_body->'body')-ARRAY['views','likes','viewCount','likeCount','updatedAt']);
            new_body=jsonb_set(new_body,'{body}',(new_body->'body')-ARRAY['views','likes','viewCount','likeCount','updatedAt']);
            old_body=old_body-ARRAY['revision','updated_at']; new_body=new_body-ARRAY['revision','updated_at'];
          ELSIF TG_TABLE_NAME='shorts_ingestion' THEN
            old_body=jsonb_build_array(old_body->'network',old_body->'contract',old_body->'id',old_body->'creator',old_body->'input',old_body->'status',old_body->'delivery_short_id');
            new_body=jsonb_build_array(new_body->'network',new_body->'contract',new_body->'id',new_body->'creator',new_body->'input',new_body->'status',new_body->'delivery_short_id');
          END IF;
          IF old_body IS NOT DISTINCT FROM new_body THEN RETURN NEW; END IF;
        END IF;
        FOR item IN SELECT DISTINCT value->>'network' AS network,value->>'contract' AS contract
          FROM jsonb_array_elements(jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW))) WHERE value IS NOT NULL AND value<>'null'::jsonb ORDER BY 1,2 LOOP
          INSERT INTO ${s}.shorts_private_storage_epochs(network,contract,revision) VALUES(item.network,item.contract,1)
            ON CONFLICT(network,contract) DO UPDATE SET revision=${s}.shorts_private_storage_epochs.revision+1;
        END LOOP;
        RETURN COALESCE(NEW,OLD);
      END $epoch$;
      REVOKE ALL ON FUNCTION ${s}.shorts_private_reference_epoch() FROM PUBLIC;
      CREATE FUNCTION ${s}.shorts_private_scan_epoch() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $scan$
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF ROW(NEW.network,NEW.contract,NEW.id,NEW.inventory_id,NEW.created_at,NEW.reference_epoch) IS DISTINCT FROM ROW(OLD.network,OLD.contract,OLD.id,OLD.inventory_id,OLD.created_at,OLD.reference_epoch) THEN RAISE EXCEPTION 'Reference epoch is immutable' USING ERRCODE='SH409'; END IF;
          RETURN NEW;
        END IF;
        INSERT INTO ${s}.shorts_private_storage_epochs(network,contract) VALUES(NEW.network,NEW.contract) ON CONFLICT DO NOTHING;
        SELECT revision INTO NEW.reference_epoch FROM ${s}.shorts_private_storage_epochs WHERE network=NEW.network AND contract=NEW.contract FOR UPDATE;
        RETURN NEW;
      END $scan$;
      REVOKE ALL ON FUNCTION ${s}.shorts_private_scan_epoch() FROM PUBLIC;
      CREATE TRIGGER shorts_private_scan_epoch BEFORE INSERT OR UPDATE ON ${s}.shorts_storage_reconciliations FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_scan_epoch();`);
        for (const table of shortsPrivateVersionCleanupSources)
          await db.query(`CREATE TRIGGER shorts_private_reference_epoch AFTER INSERT OR UPDATE OR DELETE ON ${s}.${table} FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_reference_epoch();
      CREATE TRIGGER shorts_private_reference_truncate BEFORE TRUNCATE ON ${s}.${table} FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_private_reference_epoch()`);
        await db.query(`CREATE FUNCTION ${s}.shorts_private_version_scan(net text,ctr text,scan uuid,object_identity text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $validate$
      DECLARE current_epoch bigint; run record; candidate record; content record; prefix text; owner_id text;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cleanup requires READ COMMITTED' USING ERRCODE='SH400'; END IF;
        SELECT revision INTO current_epoch FROM ${s}.shorts_private_storage_epochs WHERE network=net AND contract=ctr FOR UPDATE;
        SELECT r.*,i.storage_id,i.source_hash,i.object_prefix INTO run FROM ${s}.shorts_storage_reconciliations r
          JOIN ${s}.shorts_storage_inventory_runs i ON (i.network,i.contract,i.id)=(r.network,r.contract,r.inventory_id)
          JOIN ${s}.shorts_runtime rt ON (rt.network,rt.contract,rt.source_hash)=(i.network,i.contract,i.source_hash)
          WHERE r.network=net AND r.contract=ctr AND r.id=scan AND r.complete AND i.complete;
        IF run IS NULL OR run.reference_epoch IS NULL OR run.reference_epoch IS DISTINCT FROM current_epoch THEN
          RAISE EXCEPTION 'Complete a fresh reference scan before cleanup' USING ERRCODE='SH409'; END IF;
        SELECT * INTO candidate FROM ${s}.shorts_storage_inventory_objects
          WHERE network=net AND contract=ctr AND run_id=run.inventory_id AND identity=object_identity;
        IF candidate IS NULL OR candidate.deleted OR candidate.latest OR candidate.version_id='null' OR
          left(candidate.object_key,length(run.object_prefix))<>run.object_prefix THEN RAISE EXCEPTION 'Invalid noncurrent cleanup candidate' USING ERRCODE='SH409'; END IF;
        SELECT key_id,sha256,bytes INTO content FROM ${s}.shorts_storage_references
          WHERE network=net AND contract=ctr AND run_id=scan AND object_key=candidate.object_key LIMIT 1;
        IF content IS NULL OR content.bytes+36<>candidate.bytes OR EXISTS(SELECT FROM ${s}.shorts_storage_references
          WHERE network=net AND contract=ctr AND run_id=scan AND object_key=candidate.object_key AND
          ROW(key_id,sha256,bytes) IS DISTINCT FROM ROW(content.key_id,content.sha256,content.bytes)) THEN
          RAISE EXCEPTION 'Cleanup requires consistent verified references' USING ERRCODE='SH409'; END IF;
        owner_id=split_part(substring(candidate.object_key FROM length(run.object_prefix)+1),'/',1);
        IF EXISTS(SELECT FROM ${s}.shorts_storage_reference_roots root WHERE root.network=net AND root.contract=ctr AND root.run_id=scan
          AND (root.resource_id=owner_id OR EXISTS(SELECT FROM ${s}.shorts_storage_references ref WHERE ref.network=net AND ref.contract=ctr AND ref.run_id=scan
            AND ref.resource_id=root.resource_id AND ref.object_key=candidate.object_key))
          AND (root.active_holds>0 OR root.reasons ?| ARRAY['explicit-hold','pending-appeal','reports-without-disposition','active-preparation','active-upload','original-restaging-reference','withdrawn-content-reference'])) THEN
          RAISE EXCEPTION 'Retention or active work prevents version cleanup' USING ERRCODE='SH409'; END IF;
        RETURN jsonb_build_object('revision',current_epoch,'storageId',run.storage_id,'sourceHash',run.source_hash,'key',candidate.object_key,
          'version',candidate.version_id,'keyId',content.key_id,'sha256',content.sha256,'bytes',content.bytes);
      END $validate$;
      REVOKE ALL ON FUNCTION ${s}.shorts_private_version_scan(text,text,uuid,text) FROM PUBLIC;
      CREATE FUNCTION ${s}.shorts_private_version_operation() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $operation$
      DECLARE proof jsonb;
      BEGIN
        IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Private cleanup intent/history is immutable' USING ERRCODE='SH409'; END IF;
        proof=${s}.shorts_private_version_scan(NEW.network,NEW.contract,NEW.scan_id,NEW.identity);
        IF NEW.state<>'pending' OR ROW(NEW.storage_id,NEW.source_hash,NEW.object_key,NEW.candidate_version,NEW.key_id,NEW.sha256,NEW.bytes)
          IS DISTINCT FROM ROW(proof->>'storageId',proof->>'sourceHash',proof->>'key',proof->>'version',proof->>'keyId',proof->>'sha256',(proof->>'bytes')::bigint) THEN
          RAISE EXCEPTION 'Cleanup intent differs from inspected storage' USING ERRCODE='SH409'; END IF;
        IF EXISTS(SELECT FROM ${s}.shorts_private_version_cleanup WHERE storage_id=NEW.storage_id AND object_key=NEW.object_key AND state='pending' AND id<>NEW.id) THEN
          RAISE EXCEPTION 'Object already has pending cleanup' USING ERRCODE='SH409'; END IF;
        NEW.created_at=clock_timestamp(); RETURN NEW;
      END $operation$;
      REVOKE ALL ON FUNCTION ${s}.shorts_private_version_operation() FROM PUBLIC;
      CREATE TRIGGER shorts_private_version_operation BEFORE INSERT OR DELETE ON ${s}.shorts_private_version_cleanup FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_version_operation();
      CREATE TRIGGER shorts_private_version_truncate BEFORE TRUNCATE ON ${s}.shorts_private_version_cleanup FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_private_version_operation();
      CREATE FUNCTION ${s}.shorts_private_version_event() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $event$
      DECLARE op record; attempt record; proof jsonb;
      BEGIN
        IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Cleanup events cannot change' USING ERRCODE='SH409'; END IF;
        SELECT * INTO op FROM ${s}.shorts_private_version_cleanup WHERE id=NEW.operation_id FOR UPDATE;
        IF op IS NULL OR op.state<>'pending' THEN RAISE EXCEPTION 'Cleanup is not pending' USING ERRCODE='SH409'; END IF;
        IF NEW.kind='issued' THEN
          proof=${s}.shorts_private_version_scan(op.network,op.contract,NEW.scan_id,op.identity);
          IF ROW(op.storage_id,op.source_hash,op.object_key,op.candidate_version,op.key_id,op.sha256,op.bytes)
            IS DISTINCT FROM ROW(proof->>'storageId',proof->>'sourceHash',proof->>'key',proof->>'version',proof->>'keyId',proof->>'sha256',(proof->>'bytes')::bigint)
            OR NEW.attempt_id IS NOT NULL OR NEW.retained_version IS NULL OR NEW.retained_version=op.candidate_version THEN
            RAISE EXCEPTION 'Invalid cleanup dispatch binding' USING ERRCODE='SH409'; END IF;
          IF EXISTS(SELECT FROM ${s}.shorts_private_version_events WHERE operation_id=op.id AND kind='issued' AND created_at>clock_timestamp()-interval '30 seconds') THEN
            RAISE EXCEPTION 'Cleanup dispatch is still active' USING ERRCODE='SH409'; END IF;
          NEW.reference_epoch=(proof->>'revision')::bigint;
        ELSIF NEW.kind='cancelled' THEN
          IF NEW.attempt_id IS NOT NULL OR NEW.scan_id IS NOT NULL OR NEW.reference_epoch IS NOT NULL OR NEW.retained_version IS NOT NULL
            OR EXISTS(SELECT FROM ${s}.shorts_private_version_events WHERE operation_id=op.id AND kind='issued') THEN
            RAISE EXCEPTION 'Issued cleanup cannot be cancelled' USING ERRCODE='SH409'; END IF;
        ELSE
          SELECT * INTO attempt FROM ${s}.shorts_private_version_events WHERE id=NEW.attempt_id AND operation_id=op.id AND kind='issued';
          IF attempt IS NULL OR NEW.scan_id IS NOT NULL OR NEW.reference_epoch IS NOT NULL OR
            (NEW.kind='removed' AND NEW.retained_version IS DISTINCT FROM attempt.retained_version) OR
            (NEW.kind='uncertain' AND NEW.retained_version IS NOT NULL) THEN RAISE EXCEPTION 'Invalid cleanup outcome' USING ERRCODE='SH409'; END IF;
        END IF;
        NEW.created_at=clock_timestamp(); RETURN NEW;
      END $event$;
      REVOKE ALL ON FUNCTION ${s}.shorts_private_version_event() FROM PUBLIC;
      CREATE TRIGGER shorts_private_version_event BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_private_version_events FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_version_event();
      CREATE TRIGGER shorts_private_version_event_truncate BEFORE TRUNCATE ON ${s}.shorts_private_version_events FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_private_version_event();
      CREATE FUNCTION ${s}.shorts_private_version_settle() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $settle$
      BEGIN
        IF NEW.kind IN ('removed','cancelled') THEN UPDATE ${s}.shorts_private_version_cleanup SET state=NEW.kind WHERE id=NEW.operation_id; END IF;
        RETURN NEW;
      END $settle$;
      REVOKE ALL ON FUNCTION ${s}.shorts_private_version_settle() FROM PUBLIC;
      CREATE TRIGGER shorts_private_version_settle AFTER INSERT ON ${s}.shorts_private_version_events FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_version_settle();
      CREATE FUNCTION ${s}.shorts_private_version_state() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $state$
      BEGIN
        IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state<>'pending' OR NEW.state NOT IN ('removed','cancelled')
          OR NOT EXISTS(SELECT FROM ${s}.shorts_private_version_events WHERE operation_id=OLD.id AND kind=NEW.state) THEN
          RAISE EXCEPTION 'Cleanup state requires immutable outcome evidence' USING ERRCODE='SH409'; END IF;
        RETURN NEW;
      END $state$;
      REVOKE ALL ON FUNCTION ${s}.shorts_private_version_state() FROM PUBLIC;
      CREATE TRIGGER shorts_private_version_state BEFORE UPDATE ON ${s}.shorts_private_version_cleanup FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_version_state()`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_private_version_cleanup IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_private_version_cleanup) AS used',
        );
        if (used)
          throw new Error('Preserve private cleanup history before rollback');
        for (const table of shortsPrivateVersionCleanupSources)
          await db.query(
            `DROP TRIGGER shorts_private_reference_epoch ON ${table}; DROP TRIGGER shorts_private_reference_truncate ON ${table}`,
          );
        await db.query(`DROP TRIGGER shorts_private_scan_epoch ON shorts_storage_reconciliations;
      DROP TABLE shorts_private_version_events; DROP TABLE shorts_private_version_cleanup;
      DROP FUNCTION shorts_private_version_state(); DROP FUNCTION shorts_private_version_settle();
      DROP FUNCTION shorts_private_version_event(); DROP FUNCTION shorts_private_version_operation();
      DROP FUNCTION shorts_private_version_scan(text,text,uuid,text);
      DROP FUNCTION shorts_private_scan_epoch(); DROP FUNCTION shorts_private_reference_epoch();
      ALTER TABLE shorts_storage_reconciliations DROP COLUMN reference_epoch;
      DROP TABLE shorts_private_storage_epochs`);
      },
    },

    /** Verified private-input closure; physical removal requires separate authority. */
    ShortsPrivateInputRetirement: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
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
      },
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
      },
    },

    /** Makes accepted encrypted source children inspectable by transactional reference guards. */
    ShortsAcceptedManifests: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
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
        await shortsAcceptedManifestsEpoch(db, false);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query('LOCK TABLE shorts_ingestion IN ACCESS EXCLUSIVE MODE');
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_ingestion WHERE source_manifest IS NOT NULL) AS used',
        );
        if (used)
          throw new Error('Preserve accepted source manifests before rollback');
        await shortsAcceptedManifestsEpoch(db, true);
        await db.query(`DROP TRIGGER shorts_accepted_manifest_guard ON shorts_ingestion;
      DROP TRIGGER shorts_accepted_manifest_truncate ON shorts_ingestion;
      DROP FUNCTION shorts_accepted_manifest_guard();
      DROP FUNCTION shorts_accepted_source_refs(text,text,text,text,jsonb,text);
      ALTER TABLE shorts_ingestion DROP COLUMN source_manifest`);
      },
    },

    /** Serializes new references with retirement. A barrier is not deletion authority. */
    ShortsPrivateReferenceBarriers: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = '"' + String(schema).replaceAll('"', '""') + '"';
        for (const table of shortsPrivateReferenceBarriersSources)
          await db.query(
            `LOCK TABLE ${s}.${table} IN SHARE ROW EXCLUSIVE MODE`,
          );
        await db.query(`CREATE TABLE ${s}.shorts_private_cleanup_scopes (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,
      enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(network,contract),
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_runtime(network,contract));
    CREATE TABLE ${s}.shorts_private_input_barriers (
      id uuid PRIMARY KEY,network varchar(32) NOT NULL,contract varchar(100) NOT NULL,
      scan_id uuid NOT NULL,storage_id char(64) NOT NULL,source_hash char(64) NOT NULL,
      object_key varchar(512) NOT NULL,key_id varchar(32) NOT NULL,sha256 char(64) NOT NULL,
      bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 100000000),
      roots jsonb NOT NULL CHECK(jsonb_typeof(roots)='array' AND jsonb_array_length(roots) BETWEEN 1 AND 128),
      reference_epoch bigint NOT NULL CHECK(reference_epoch>=0),
      state varchar(9) NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','sealed','cancelled')),
      seal_scan_id uuid,sealed_at timestamptz,cancelled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_private_cleanup_scopes(network,contract),
      FOREIGN KEY(network,contract,scan_id) REFERENCES ${s}.shorts_storage_reconciliations(network,contract,id),
      FOREIGN KEY(network,contract,seal_scan_id) REFERENCES ${s}.shorts_storage_reconciliations(network,contract,id));
    CREATE UNIQUE INDEX shorts_private_input_barrier_key ON ${s}.shorts_private_input_barriers(network,contract,object_key) WHERE state<>'cancelled';
    REVOKE ALL ON ${s}.shorts_private_cleanup_scopes,${s}.shorts_private_input_barriers FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_barrier_lock(net text,ctr text) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $lock$
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cleanup requires READ COMMITTED' USING ERRCODE='SH400'; END IF;
        PERFORM 1 FROM ${s}.shorts_private_storage_epochs WHERE network=net AND contract=ctr FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Private reference epoch missing' USING ERRCODE='SH409'; END IF;
      END $lock$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_barrier_lock(text,text) FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_cleanup_enrolment() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $enrol$
      BEGIN
        IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Cleanup enrolment is permanent' USING ERRCODE='SH409'; END IF;
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cleanup requires READ COMMITTED' USING ERRCODE='SH400'; END IF;
        INSERT INTO ${s}.shorts_private_storage_epochs(network,contract,revision) VALUES(NEW.network,NEW.contract,1)
          ON CONFLICT(network,contract) DO UPDATE SET revision=${s}.shorts_private_storage_epochs.revision+1;
        NEW.enrolled_at=clock_timestamp(); RETURN NEW;
      END $enrol$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_cleanup_enrolment() FROM PUBLIC;
    CREATE TRIGGER shorts_private_cleanup_enrolment BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_private_cleanup_scopes
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_cleanup_enrolment();
    CREATE TRIGGER shorts_private_cleanup_enrolment_truncate BEFORE TRUNCATE ON ${s}.shorts_private_cleanup_scopes
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_private_cleanup_enrolment();
    CREATE FUNCTION ${s}.shorts_private_barrier_proof(net text,ctr text,scan uuid,object_key text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $proof$
      DECLARE run record; epoch bigint; ref jsonb; root record; receipt record; current jsonb; bindings jsonb='[]'; owner_id text;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cleanup requires READ COMMITTED' USING ERRCODE='SH400'; END IF;
        -- Source writers lock content before their AFTER epoch trigger. Preserve that order,
        -- including every canonical Short sharing this key, before inspecting current policy.
        PERFORM c.id FROM ${s}.shorts_content c WHERE c.network=net AND c.contract=ctr AND c.id IN (
          SELECT p.short_id FROM ${s}.shorts_private_input_retirements p JOIN ${s}.shorts_storage_references r
            ON (r.network,r.contract,r.resource_id)=(p.network,p.contract,p.resource_id)
            WHERE r.network=net AND r.contract=ctr AND r.run_id=scan AND r.object_key=shorts_private_barrier_proof.object_key
        ) ORDER BY c.id FOR UPDATE;
        SELECT revision INTO epoch FROM ${s}.shorts_private_storage_epochs WHERE network=net AND contract=ctr FOR UPDATE;
        SELECT r.*,i.storage_id,i.source_hash,i.object_prefix INTO run FROM ${s}.shorts_storage_reconciliations r
          JOIN ${s}.shorts_storage_inventory_runs i ON (i.network,i.contract,i.id)=(r.network,r.contract,r.inventory_id)
          JOIN ${s}.shorts_runtime rt ON (rt.network,rt.contract,rt.source_hash)=(i.network,i.contract,i.source_hash)
          WHERE r.network=net AND r.contract=ctr AND r.id=scan AND r.complete AND i.complete;
        IF run IS NULL OR run.reference_epoch IS DISTINCT FROM epoch OR epoch IS NULL
          OR NOT EXISTS(SELECT FROM ${s}.shorts_private_cleanup_scopes WHERE network=net AND contract=ctr) THEN
          RAISE EXCEPTION 'Complete a fresh enrolled reference scan before cleanup' USING ERRCODE='SH409'; END IF;
        IF left(object_key,length(run.object_prefix)) IS DISTINCT FROM run.object_prefix
          OR NOT EXISTS(SELECT FROM ${s}.shorts_storage_inventory_objects i WHERE i.network=net AND i.contract=ctr
            AND i.run_id=run.inventory_id AND i.object_key=shorts_private_barrier_proof.object_key AND NOT i.deleted AND i.version_id<>'null') THEN
          RAISE EXCEPTION 'Object is not in the completed version inventory' USING ERRCODE='SH409'; END IF;
        SELECT jsonb_build_object('key',r.object_key,'keyId',r.key_id,'sha256',r.sha256,'bytes',r.bytes) INTO ref
          FROM ${s}.shorts_storage_references r WHERE r.network=net AND r.contract=ctr AND r.run_id=scan
            AND r.object_key=shorts_private_barrier_proof.object_key LIMIT 1;
        IF ref IS NULL OR EXISTS(SELECT FROM ${s}.shorts_storage_references r WHERE r.network=net AND r.contract=ctr AND r.run_id=scan
          AND r.object_key=shorts_private_barrier_proof.object_key AND
          jsonb_build_object('key',r.object_key,'keyId',r.key_id,'sha256',r.sha256,'bytes',r.bytes) IS DISTINCT FROM ref) THEN
          RAISE EXCEPTION 'Cleanup requires consistent verified references' USING ERRCODE='SH409'; END IF;
        owner_id=split_part(substring(object_key FROM length(run.object_prefix)+1),'/',1);
        IF EXISTS(SELECT FROM ${s}.shorts_storage_reference_roots r WHERE r.network=net AND r.contract=ctr AND r.run_id=scan
          AND r.resource_id=owner_id AND (r.active_holds>0 OR r.reasons ?| ARRAY['pending-appeal','reports-without-disposition',
            'active-preparation','active-upload','original-restaging-reference','withdrawn-content-reference'])) THEN
          RAISE EXCEPTION 'Object owner retains private inputs' USING ERRCODE='SH409'; END IF;
        FOR root IN SELECT r.resource_id,r.active_holds,r.reasons FROM ${s}.shorts_storage_reference_roots r
          JOIN ${s}.shorts_storage_references e USING(network,contract,run_id,resource_id)
          WHERE e.network=net AND e.contract=ctr AND e.run_id=scan AND e.object_key=shorts_private_barrier_proof.object_key ORDER BY r.resource_id LOOP
          IF root.active_holds>0 OR root.reasons ?| ARRAY['pending-appeal','reports-without-disposition','active-preparation',
            'active-upload','original-restaging-reference','withdrawn-content-reference']
            OR (SELECT count(*) FROM ${s}.shorts_private_input_retirements p WHERE p.network=net AND p.contract=ctr AND p.resource_id=root.resource_id)<>1 THEN
            RAISE EXCEPTION 'Every reference must have eligible retired private inputs' USING ERRCODE='SH409'; END IF;
          SELECT * INTO receipt FROM ${s}.shorts_private_input_retirements p WHERE p.network=net AND p.contract=ctr AND p.resource_id=root.resource_id;
          current=${s}.shorts_private_input_snapshot(net,ctr,receipt.short_id,receipt.source_key);
          IF current->>'rootHash' IS DISTINCT FROM receipt.root_hash OR NOT receipt.objects @> jsonb_build_array(ref) THEN
            RAISE EXCEPTION 'Retired private source references changed' USING ERRCODE='SH409'; END IF;
          bindings=bindings||jsonb_build_array(jsonb_build_object('shortId',receipt.short_id,'sourceKey',receipt.source_key,
            'resourceId',receipt.resource_id,'rootHash',receipt.root_hash,'retirementId',receipt.operation_id));
          IF jsonb_array_length(bindings)>128 THEN RAISE EXCEPTION 'Too many shared private roots' USING ERRCODE='SH409'; END IF;
        END LOOP;
        IF jsonb_array_length(bindings)=0 OR EXISTS(SELECT FROM ${s}.shorts_private_version_cleanup v
          WHERE v.storage_id=run.storage_id AND v.object_key=shorts_private_barrier_proof.object_key AND v.state='pending') THEN
          RAISE EXCEPTION 'Private cleanup references are unavailable' USING ERRCODE='SH409'; END IF;
        RETURN jsonb_build_object('storageId',run.storage_id,'sourceHash',run.source_hash,'object',ref,'roots',bindings,'epoch',epoch::text);
      END $proof$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_barrier_proof(text,text,uuid,text) FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_input_barrier_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      DECLARE proof jsonb;
      BEGIN
        IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Preserve private cleanup barriers' USING ERRCODE='SH409'; END IF;
        IF TG_OP='UPDATE' THEN
          IF OLD.state<>'reserved' OR NEW.state NOT IN ('sealed','cancelled')
            OR (to_jsonb(NEW)-ARRAY['state','seal_scan_id','sealed_at','cancelled_at']) IS DISTINCT FROM
               (to_jsonb(OLD)-ARRAY['state','seal_scan_id','sealed_at','cancelled_at']) THEN
            RAISE EXCEPTION 'Private cleanup barrier is immutable' USING ERRCODE='SH409'; END IF;
          IF NEW.state='cancelled' THEN
            IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cleanup requires READ COMMITTED' USING ERRCODE='SH400'; END IF;
            PERFORM 1 FROM ${s}.shorts_private_storage_epochs WHERE network=NEW.network AND contract=NEW.contract FOR UPDATE;
            NEW.seal_scan_id=NULL; NEW.sealed_at=NULL; NEW.cancelled_at=clock_timestamp(); RETURN NEW;
          END IF;
          proof=${s}.shorts_private_barrier_proof(NEW.network,NEW.contract,NEW.seal_scan_id,NEW.object_key);
          IF proof->'roots' IS DISTINCT FROM OLD.roots OR proof->>'storageId' IS DISTINCT FROM OLD.storage_id
            OR proof->>'sourceHash' IS DISTINCT FROM OLD.source_hash OR proof->'object' IS DISTINCT FROM
              jsonb_build_object('key',OLD.object_key,'keyId',OLD.key_id,'sha256',OLD.sha256,'bytes',OLD.bytes) THEN
            RAISE EXCEPTION 'Private cleanup barrier proof changed' USING ERRCODE='SH409'; END IF;
          NEW.sealed_at=clock_timestamp(); NEW.cancelled_at=NULL; RETURN NEW;
        END IF;
        IF NEW.state<>'reserved' OR NEW.seal_scan_id IS NOT NULL OR NEW.sealed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
          RAISE EXCEPTION 'Invalid initial cleanup barrier' USING ERRCODE='SH400'; END IF;
        proof=${s}.shorts_private_barrier_proof(NEW.network,NEW.contract,NEW.scan_id,NEW.object_key);
        NEW.storage_id=proof->>'storageId'; NEW.source_hash=proof->>'sourceHash'; NEW.key_id=proof#>>'{object,keyId}';
        NEW.sha256=proof#>>'{object,sha256}'; NEW.bytes=(proof#>>'{object,bytes}')::bigint;
        NEW.roots=proof->'roots'; NEW.reference_epoch=(proof->>'epoch')::bigint; NEW.created_at=clock_timestamp(); RETURN NEW;
      END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_input_barrier_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_private_input_barrier_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_private_input_barriers
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_input_barrier_guard();
    CREATE TRIGGER shorts_private_input_barrier_truncate BEFORE TRUNCATE ON ${s}.shorts_private_input_barriers
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_private_input_barrier_guard();`);
        await shortsPrivateReferenceBarriersWriters(db, s);
        // Selection changes renew the rollback window even though object edges stay equal.
        await db.query(`CREATE TRIGGER shorts_private_reference_epoch AFTER INSERT ON ${s}.shorts_delivery_selections
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_reference_epoch()`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_private_cleanup_scopes,shorts_private_input_barriers IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_private_cleanup_scopes) AS used',
        );
        if (used)
          throw new Error(
            'Preserve enrolled private cleanup barriers before rollback',
          );
        for (const table of shortsPrivateReferenceBarriersSources)
          await db.query(
            `DROP TRIGGER shorts_private_reference_barrier ON ${table}`,
          );
        await db.query(`DROP TRIGGER shorts_private_version_z_barrier ON shorts_private_version_cleanup;
      DROP TRIGGER shorts_private_reference_epoch ON shorts_delivery_selections;
      DROP FUNCTION shorts_private_version_barrier_guard();
      DROP FUNCTION shorts_private_reference_barrier(); DROP FUNCTION shorts_private_direct_refs(text,jsonb);
      DROP TABLE shorts_private_input_barriers; DROP TABLE shorts_private_cleanup_scopes;
      DROP FUNCTION shorts_private_input_barrier_guard(); DROP FUNCTION shorts_private_cleanup_enrolment();
      DROP FUNCTION shorts_private_barrier_lock(text,text);
      DROP FUNCTION shorts_private_barrier_proof(text,text,uuid,text)`);
      },
    },

    /** Separate media-verifier and deletion-operator authority for sealed private inputs. */
    ShortsPrivateInputCleanupJournal: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = '"' + String(schema).replaceAll('"', '""') + '"';
        await db.query(`CREATE FUNCTION ${s}.shorts_private_sealed_snapshot(barrier uuid) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $snapshot$
      DECLARE b record; item jsonb; receipt record; current jsonb; package record; records jsonb='[]'; durable jsonb='[]';
        ref jsonb; owner_id text; parent_id text; epoch bigint; guarded integer; media_identity jsonb;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cleanup requires READ COMMITTED' USING ERRCODE='SH400'; END IF;
        SELECT * INTO b FROM ${s}.shorts_private_input_barriers WHERE id=barrier;
        IF NOT FOUND OR b.state<>'sealed' THEN RAISE EXCEPTION 'A permanent private reference barrier is required' USING ERRCODE='SH409'; END IF;
        SELECT count(*) INTO guarded FROM pg_trigger WHERE tgname='shorts_private_reference_barrier' AND tgenabled IN ('O','A')
          AND tgrelid=ANY(ARRAY['${s}.shorts_content'::regclass,'${s}.shorts_ingestion'::regclass,'${s}.shorts_upload_sessions'::regclass,
            '${s}.shorts_upload_parts'::regclass,'${s}.shorts_delivery_generations'::regclass,'${s}.shorts_delivery_staging'::regclass]);
        IF guarded<>6 THEN RAISE EXCEPTION 'Private reference barriers are unavailable' USING ERRCODE='SH409'; END IF;
        SELECT count(*) INTO guarded FROM pg_trigger WHERE tgname='shorts_private_reference_epoch' AND tgenabled IN ('O','A')
          AND tgrelid=ANY(ARRAY['${s}.shorts_content'::regclass,'${s}.shorts_ingestion'::regclass,'${s}.shorts_upload_sessions'::regclass,
            '${s}.shorts_upload_parts'::regclass,'${s}.shorts_retention_holds'::regclass,'${s}.shorts_delivery_packages'::regclass,
            '${s}.shorts_delivery_generations'::regclass,'${s}.shorts_delivery_staging'::regclass,'${s}.shorts_delivery_selections'::regclass]);
        IF guarded<>9 THEN RAISE EXCEPTION 'Private policy serialization is unavailable' USING ERRCODE='SH409'; END IF;
        owner_id=split_part(b.object_key,'/',3);
        SELECT short_id INTO parent_id FROM ${s}.shorts_delivery_generations WHERE network=b.network AND contract=b.contract AND job_id=owner_id;
        -- A sealed key cannot gain another referring root. Lock its known canonical
        -- roots before the epoch, then recheck their current state rather than
        -- rejecting unrelated uploads that happened during media verification.
        PERFORM id FROM ${s}.shorts_content WHERE network=b.network AND contract=b.contract
          AND (id IN (owner_id,parent_id) OR id IN (SELECT value->>'shortId' FROM jsonb_array_elements(b.roots))) ORDER BY id FOR UPDATE;
        SELECT revision INTO epoch FROM ${s}.shorts_private_storage_epochs WHERE network=b.network AND contract=b.contract FOR UPDATE;
        IF epoch IS NULL OR NOT EXISTS(SELECT FROM ${s}.shorts_runtime WHERE network=b.network AND contract=b.contract AND source_hash=b.source_hash) THEN
          RAISE EXCEPTION 'Private cleanup deployment changed' USING ERRCODE='SH409'; END IF;
        IF EXISTS(SELECT FROM ${s}.shorts_retention_holds WHERE network=b.network AND contract=b.contract AND released_at IS NULL
            AND (resource_id IN (owner_id,parent_id) OR resource_id IN (SELECT value->>'resourceId' FROM jsonb_array_elements(b.roots))
              OR resource_id IN (SELECT value->>'shortId' FROM jsonb_array_elements(b.roots))))
          OR EXISTS(SELECT FROM ${s}.shorts_ingestion WHERE network=b.network AND contract=b.contract AND id=owner_id AND status IN ('queued','processing'))
          OR EXISTS(SELECT FROM ${s}.shorts_upload_sessions WHERE network=b.network AND contract=b.contract AND id=owner_id AND state<>'enqueued')
          OR EXISTS(SELECT FROM ${s}.shorts_delivery_staging WHERE network=b.network AND contract=b.contract AND job_id=owner_id AND state<>'ready') THEN
          RAISE EXCEPTION 'Private object is retained by active work or a hold' USING ERRCODE='SH409'; END IF;
        IF EXISTS(SELECT FROM (
          SELECT body FROM ${s}.shorts_content WHERE network=b.network AND contract=b.contract AND id IN (owner_id,parent_id)
          UNION ALL SELECT body FROM ${s}.shorts_delivery_generations WHERE network=b.network AND contract=b.contract AND job_id=owner_id
        ) owners WHERE body->>'publication'='withdrawn' OR body#>>'{appeal,status}'='pending'
          OR COALESCE((body->>'reports')::integer,0)>0 OR COALESCE(jsonb_array_length(body->'reportDetails'),0)>0) THEN
          RAISE EXCEPTION 'Private object owner is retained by policy' USING ERRCODE='SH409'; END IF;
        ref=jsonb_build_object('key',b.object_key,'keyId',b.key_id,'bytes',b.bytes,'sha256',b.sha256);
        FOR item IN SELECT value FROM jsonb_array_elements(b.roots) ORDER BY value->>'shortId',value->>'resourceId' LOOP
          SELECT * INTO receipt FROM ${s}.shorts_private_input_retirements WHERE network=b.network AND contract=b.contract
            AND short_id=item->>'shortId' AND source_key=item->>'sourceKey';
          IF NOT FOUND OR receipt.resource_id IS DISTINCT FROM item->>'resourceId' OR receipt.operation_id::text IS DISTINCT FROM item->>'retirementId'
            OR receipt.root_hash IS DISTINCT FROM item->>'rootHash' OR NOT receipt.objects @> jsonb_build_array(ref) THEN
            RAISE EXCEPTION 'Private retirement closure changed' USING ERRCODE='SH409'; END IF;
          current=${s}.shorts_private_input_snapshot(b.network,b.contract,receipt.short_id,receipt.source_key);
          IF current->>'rootHash' IS DISTINCT FROM receipt.root_hash THEN
            RAISE EXCEPTION 'Retired private source references changed' USING ERRCODE='SH409'; END IF;
          SELECT source_identity,prepared INTO package FROM ${s}.shorts_delivery_packages WHERE network=b.network AND contract=b.contract
            AND short_id=receipt.short_id AND source_key=receipt.source_key;
          media_identity=jsonb_build_array(item,current#>'{record,cid}',current#>'{record,original}',current#>'{record,derivatives}',
            current#>'{record,files}',current#>'{record,bytes}',current#>'{record,captions}',current#>'{record,duration}',package.source_identity,package.prepared);
          records=records||jsonb_build_array(item||jsonb_build_object('record',current->'record',
            'durabilityHash',encode(sha256(convert_to(media_identity::text,'UTF8')),'hex')));
          durable=durable||jsonb_build_array(media_identity);
          IF octet_length(records::text)+octet_length(durable::text)>8388608 THEN
            RAISE EXCEPTION 'Private verification closure is too large' USING ERRCODE='SH409'; END IF;
        END LOOP;
        RETURN jsonb_build_object('barrierId',b.id,'scope',jsonb_build_object('network',b.network,'contract',b.contract),'ref',ref,
          'storageId',b.storage_id,'sourceHash',b.source_hash,'records',records,'epoch',epoch::text,'observedAt',clock_timestamp(),
          'stateHash',encode(sha256(convert_to(jsonb_build_array(b.id,b.storage_id,b.source_hash,ref,durable)::text,'UTF8')),'hex'));
      END $snapshot$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_sealed_snapshot(uuid) FROM PUBLIC;
    CREATE TABLE ${s}.shorts_private_input_cleanup (
      id uuid PRIMARY KEY,barrier_id uuid NOT NULL REFERENCES ${s}.shorts_private_input_barriers(id),
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,inventory_id uuid NOT NULL,identity char(64) NOT NULL,
      version_id text NOT NULL CHECK(octet_length(version_id) BETWEEN 1 AND 1024 AND version_id<>'null'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(barrier_id,version_id),
      FOREIGN KEY(network,contract,inventory_id) REFERENCES ${s}.shorts_storage_inventory_runs(network,contract,id));
    CREATE TABLE ${s}.shorts_private_input_verifications (
      id uuid PRIMARY KEY,operation_id uuid NOT NULL REFERENCES ${s}.shorts_private_input_cleanup(id),
      state_hash char(64) NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),reference_epoch bigint NOT NULL CHECK(reference_epoch>=0),
      started_at timestamptz NOT NULL,verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL);
    CREATE TABLE ${s}.shorts_private_input_attempts (
      id uuid PRIMARY KEY,operation_id uuid NOT NULL REFERENCES ${s}.shorts_private_input_cleanup(id),
      verification_id uuid NOT NULL UNIQUE REFERENCES ${s}.shorts_private_input_verifications(id),
      reference_epoch bigint NOT NULL CHECK(reference_epoch>=0),issued_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE TABLE ${s}.shorts_private_input_outcomes (
      id uuid PRIMARY KEY,attempt_id uuid NOT NULL REFERENCES ${s}.shorts_private_input_attempts(id),
      kind varchar(9) NOT NULL CHECK(kind IN ('uncertain','removed')),observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(attempt_id,kind));
    CREATE INDEX shorts_private_input_verifications_operation ON ${s}.shorts_private_input_verifications(operation_id,verified_at);
    CREATE INDEX shorts_private_input_attempts_operation ON ${s}.shorts_private_input_attempts(operation_id,issued_at);
    REVOKE ALL ON ${s}.shorts_private_input_cleanup,${s}.shorts_private_input_verifications,${s}.shorts_private_input_attempts,${s}.shorts_private_input_outcomes FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_cleanup_snapshot(operation uuid) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $operation$
      DECLARE op record; snapshot jsonb;
      BEGIN
        SELECT * INTO op FROM ${s}.shorts_private_input_cleanup WHERE id=operation;
        IF NOT FOUND THEN RAISE EXCEPTION 'Private cleanup operation is missing' USING ERRCODE='SH409'; END IF;
        snapshot=${s}.shorts_private_sealed_snapshot(op.barrier_id);
        PERFORM 1 FROM ${s}.shorts_private_input_cleanup WHERE id=operation FOR UPDATE;
        IF EXISTS(SELECT FROM ${s}.shorts_private_input_attempts a JOIN ${s}.shorts_private_input_outcomes o ON o.attempt_id=a.id
          WHERE a.operation_id=operation AND o.kind='removed') THEN
          RAISE EXCEPTION 'Private version is already removed' USING ERRCODE='SH409'; END IF;
        RETURN snapshot||jsonb_build_object('operationId',op.id,'version',op.version_id);
      END $operation$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_cleanup_snapshot(uuid) FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_cleanup_lock_batch(chain text,address text,operations uuid[]) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $batch$
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' OR array_ndims(operations) IS DISTINCT FROM 1
          OR cardinality(operations) NOT BETWEEN 1 AND 128 OR cardinality(operations)<>(SELECT count(DISTINCT id) FROM unnest(operations) id)
          OR cardinality(operations)<>(SELECT count(*) FROM ${s}.shorts_private_input_cleanup WHERE network=chain AND contract=address AND id=ANY(operations)) THEN
          RAISE EXCEPTION 'Invalid scoped cleanup batch' USING ERRCODE='SH400'; END IF;
        -- Every canonical row precedes the epoch lock, including across distinct
        -- objects/Shorts. Per-row triggers then recheck policy under these locks.
        PERFORM c.id FROM ${s}.shorts_content c WHERE c.network=chain AND c.contract=address AND c.id IN (
          WITH selected AS (SELECT b.* FROM ${s}.shorts_private_input_barriers b JOIN ${s}.shorts_private_input_cleanup o ON o.barrier_id=b.id WHERE o.id=ANY(operations))
          SELECT split_part(object_key,'/',3) FROM selected
          UNION SELECT g.short_id FROM ${s}.shorts_delivery_generations g JOIN selected b ON g.network=b.network AND g.contract=b.contract AND g.job_id=split_part(b.object_key,'/',3)
          UNION SELECT value->>'shortId' FROM selected b CROSS JOIN LATERAL jsonb_array_elements(b.roots)
        ) ORDER BY c.id FOR UPDATE;
        PERFORM revision FROM ${s}.shorts_private_storage_epochs WHERE network=chain AND contract=address FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Private cleanup epoch is unavailable' USING ERRCODE='SH409'; END IF;
      END $batch$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_cleanup_lock_batch(text,text,uuid[]) FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_private_cleanup_journal_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $journal$
      DECLARE snapshot jsonb; candidate record; proof record; attempt record; moment timestamptz;
      BEGIN
        IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Private cleanup journal is immutable' USING ERRCODE='SH409'; END IF;
        IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Cleanup requires READ COMMITTED' USING ERRCODE='SH400'; END IF;
        IF TG_TABLE_NAME='shorts_private_input_cleanup' THEN
          snapshot=${s}.shorts_private_sealed_snapshot(NEW.barrier_id);
          SELECT o.* INTO candidate FROM ${s}.shorts_storage_inventory_objects o JOIN ${s}.shorts_storage_inventory_runs i
            ON (i.network,i.contract,i.id)=(o.network,o.contract,o.run_id)
            WHERE i.network=snapshot#>>'{scope,network}' AND i.contract=snapshot#>>'{scope,contract}' AND i.id=NEW.inventory_id AND i.complete
              AND i.storage_id=snapshot->>'storageId' AND i.source_hash=snapshot->>'sourceHash' AND o.identity=NEW.identity;
          IF NOT FOUND OR candidate.deleted OR candidate.version_id='null' OR candidate.object_key IS DISTINCT FROM snapshot#>>'{ref,key}'
            OR candidate.bytes IS DISTINCT FROM (snapshot#>>'{ref,bytes}')::bigint+36 THEN
            RAISE EXCEPTION 'Private version differs from the completed inventory' USING ERRCODE='SH409'; END IF;
          NEW.network=snapshot#>>'{scope,network}'; NEW.contract=snapshot#>>'{scope,contract}'; NEW.version_id=candidate.version_id;
          NEW.created_at=clock_timestamp(); RETURN NEW;
        ELSIF TG_TABLE_NAME='shorts_private_input_verifications' THEN
          snapshot=${s}.shorts_private_cleanup_snapshot(NEW.operation_id); moment=clock_timestamp();
          IF NEW.state_hash IS DISTINCT FROM snapshot->>'stateHash' OR NEW.started_at>transaction_timestamp() OR NEW.started_at<moment-interval '300 seconds'
            OR transaction_timestamp()+interval '30 seconds'<=moment THEN
            RAISE EXCEPTION 'Private durability verification changed or expired' USING ERRCODE='SH409'; END IF;
          NEW.reference_epoch=(snapshot->>'epoch')::bigint; NEW.verified_at=transaction_timestamp(); NEW.expires_at=NEW.verified_at+interval '30 seconds'; RETURN NEW;
        ELSIF TG_TABLE_NAME='shorts_private_input_attempts' THEN
          SELECT * INTO proof FROM ${s}.shorts_private_input_verifications WHERE id=NEW.verification_id;
          IF NOT FOUND OR proof.operation_id IS DISTINCT FROM NEW.operation_id THEN
            RAISE EXCEPTION 'Private deletion needs matching durability verification' USING ERRCODE='SH409'; END IF;
          snapshot=${s}.shorts_private_cleanup_snapshot(NEW.operation_id); moment=clock_timestamp();
          IF proof.expires_at<=moment OR proof.state_hash IS DISTINCT FROM snapshot->>'stateHash' THEN
            RAISE EXCEPTION 'Private durability verification changed or expired' USING ERRCODE='SH409'; END IF;
          IF EXISTS(SELECT FROM ${s}.shorts_private_input_attempts WHERE operation_id=NEW.operation_id AND issued_at>moment-interval '30 seconds') THEN
            RAISE EXCEPTION 'Private deletion dispatch is still active' USING ERRCODE='SH409'; END IF;
          NEW.reference_epoch=(snapshot->>'epoch')::bigint; NEW.issued_at=moment; RETURN NEW;
        ELSE
          SELECT * INTO attempt FROM ${s}.shorts_private_input_attempts WHERE id=NEW.attempt_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'Private outcome needs an issued attempt' USING ERRCODE='SH409'; END IF;
          PERFORM 1 FROM ${s}.shorts_private_input_cleanup WHERE id=attempt.operation_id FOR UPDATE;
          IF NEW.kind='uncertain' AND EXISTS(SELECT FROM ${s}.shorts_private_input_attempts a JOIN ${s}.shorts_private_input_outcomes o ON o.attempt_id=a.id
            WHERE a.operation_id=attempt.operation_id AND o.kind='removed') THEN
            RAISE EXCEPTION 'Private removal is already confirmed' USING ERRCODE='SH409'; END IF;
          NEW.observed_at=clock_timestamp(); RETURN NEW;
        END IF;
      END $journal$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_cleanup_journal_guard() FROM PUBLIC;`);
        await db.query(`CREATE FUNCTION ${s}.shorts_private_cleanup_dispatch(attempt_id uuid) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $dispatch$
      DECLARE attempt record; proof record; snapshot jsonb;
      BEGIN
        SELECT * INTO attempt FROM ${s}.shorts_private_input_attempts WHERE id=attempt_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Private deletion attempt is missing' USING ERRCODE='SH409'; END IF;
        SELECT * INTO proof FROM ${s}.shorts_private_input_verifications WHERE id=attempt.verification_id;
        snapshot=${s}.shorts_private_cleanup_snapshot(attempt.operation_id);
        IF clock_timestamp()>=attempt.issued_at+interval '30 seconds' OR clock_timestamp()>=proof.expires_at
          OR snapshot->>'stateHash' IS DISTINCT FROM proof.state_hash THEN
          RAISE EXCEPTION 'Private deletion authority changed or expired' USING ERRCODE='SH409'; END IF;
        RETURN (snapshot-'records')||jsonb_build_object('attemptId',attempt.id,'issuedAt',attempt.issued_at,
          'expiresAt',least(proof.expires_at,attempt.issued_at+interval '30 seconds'));
      END $dispatch$;
    REVOKE ALL ON FUNCTION ${s}.shorts_private_cleanup_dispatch(uuid) FROM PUBLIC;`);
        for (const table of [
          'shorts_private_input_cleanup',
          'shorts_private_input_verifications',
          'shorts_private_input_attempts',
          'shorts_private_input_outcomes',
        ]) {
          await db.query(`CREATE TRIGGER shorts_private_cleanup_journal BEFORE INSERT OR UPDATE OR DELETE ON ${s}.${table}
        FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_cleanup_journal_guard();
        CREATE TRIGGER shorts_private_cleanup_journal_truncate BEFORE TRUNCATE ON ${s}.${table}
        FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_private_cleanup_journal_guard()`);
        }
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_private_input_cleanup IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_private_input_cleanup) AS used',
        );
        if (used)
          throw new Error('Preserve private cleanup journal before rollback');
        await db.query(`DROP TABLE shorts_private_input_outcomes; DROP TABLE shorts_private_input_attempts;
      DROP TABLE shorts_private_input_verifications; DROP TABLE shorts_private_input_cleanup;
      DROP FUNCTION shorts_private_cleanup_journal_guard(); DROP FUNCTION shorts_private_cleanup_dispatch(uuid); DROP FUNCTION shorts_private_cleanup_snapshot(uuid);
      DROP FUNCTION shorts_private_sealed_snapshot(uuid); DROP FUNCTION shorts_private_cleanup_lock_batch(text,text,uuid[])`);
      },
    },
  };
}
