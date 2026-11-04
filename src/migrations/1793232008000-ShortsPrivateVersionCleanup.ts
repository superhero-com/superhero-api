import { MigrationInterface, QueryRunner } from 'typeorm';

const SOURCES = [
  'shorts_content',
  'shorts_ingestion',
  'shorts_upload_sessions',
  'shorts_upload_parts',
  'shorts_retention_holds',
  'shorts_delivery_packages',
  'shorts_delivery_generations',
  'shorts_delivery_staging',
];

export class ShortsPrivateVersionCleanup1793232008000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = '"' + schema.replaceAll('"', '""') + '"';
    // All additive source readers must exist before cleanup can acquire authority.
    for (const table of SOURCES)
      await db.query(`LOCK TABLE ${s}.${table} IN SHARE ROW EXCLUSIVE MODE`);
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
    for (const table of SOURCES)
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
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_private_version_cleanup IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_private_version_cleanup) AS used',
    );
    if (used)
      throw new Error('Preserve private cleanup history before rollback');
    for (const table of SOURCES)
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
  }
}
