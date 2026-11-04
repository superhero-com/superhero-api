import { MigrationInterface, QueryRunner } from 'typeorm';

const SOURCES = [
  'shorts_content',
  'shorts_ingestion',
  'shorts_upload_sessions',
  'shorts_upload_parts',
  'shorts_delivery_generations',
  'shorts_delivery_staging',
];

/** Serializes new references with retirement. A barrier is not deletion authority. */
export class ShortsPrivateReferenceBarriers1793491202000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = '"' + String(schema).replaceAll('"', '""') + '"';
    for (const table of SOURCES)
      await db.query(`LOCK TABLE ${s}.${table} IN SHARE ROW EXCLUSIVE MODE`);
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
    await this.writers(db, s);
    // Selection changes renew the rollback window even though object edges stay equal.
    await db.query(`CREATE TRIGGER shorts_private_reference_epoch AFTER INSERT ON ${s}.shorts_delivery_selections
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_private_reference_epoch()`);
  }

  private async writers(db: QueryRunner, s: string) {
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
        -- so explicit SET CONSTRAINTS and legacy callers have the same boundary.
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
    for (const table of SOURCES)
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
    for (const table of SOURCES)
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
  }
}
