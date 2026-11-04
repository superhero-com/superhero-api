import { MigrationInterface, QueryRunner } from 'typeorm';

/** Separate media-verifier and deletion-operator authority for sealed private inputs. */
export class ShortsPrivateInputCleanupJournal1793491203000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
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
  }

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
  }
}
