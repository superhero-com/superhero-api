import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsBackfillBatches1793232006000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_backfill_batches (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id uuid NOT NULL,
      request jsonb NOT NULL CHECK(octet_length(request::text)<=16384),
      plan jsonb NOT NULL CHECK(octet_length(plan::text)<=32768),
      status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','cancelled')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_token uuid, lease_until timestamptz,
      PRIMARY KEY(network,contract,id), FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_runtime(network,contract),
      CHECK((lease_token IS NULL)=(lease_until IS NULL))
    );
    CREATE UNIQUE INDEX shorts_backfill_one_active ON ${s}.shorts_backfill_batches(network,contract) WHERE status='running';
    CREATE TABLE ${s}.shorts_backfill_items (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, batch_id uuid NOT NULL,
      ordinal smallint NOT NULL CHECK(ordinal BETWEEN 0 AND 9), short_id varchar(80) NOT NULL,
      job_id varchar(80) NOT NULL, operation_id uuid NOT NULL, plan jsonb NOT NULL,
      phase text NOT NULL DEFAULT 'planned' CHECK(phase IN ('planned','preparing','ready','activated','failed','cancelled')),
      failures smallint NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 3),
      source_key text CHECK(source_key ~ '^[a-f0-9]{64}$'), error_code varchar(40),
      PRIMARY KEY(network,contract,batch_id,ordinal), UNIQUE(network,contract,job_id), UNIQUE(operation_id),
      UNIQUE(network,contract,batch_id,short_id),
      FOREIGN KEY(network,contract,batch_id) REFERENCES ${s}.shorts_backfill_batches(network,contract,id),
      FOREIGN KEY(network,contract,short_id) REFERENCES ${s}.shorts_content(network,contract,id)
    );
    REVOKE ALL ON ${s}.shorts_backfill_batches,${s}.shorts_backfill_items FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_backfill_identity_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Backfill history is retained' USING ERRCODE='SH409'; END IF;
      IF TG_TABLE_NAME='shorts_backfill_batches' THEN
        IF ROW(NEW.network,NEW.contract,NEW.id,NEW.request,NEW.plan,NEW.created_at) IS DISTINCT FROM
          ROW(OLD.network,OLD.contract,OLD.id,OLD.request,OLD.plan,OLD.created_at)
          OR (OLD.status<>'running' AND NEW.status<>OLD.status) THEN
          RAISE EXCEPTION 'Backfill identity is immutable' USING ERRCODE='SH409'; END IF;
      ELSE
        IF ROW(NEW.network,NEW.contract,NEW.batch_id,NEW.ordinal,NEW.short_id,NEW.job_id,NEW.operation_id,NEW.plan) IS DISTINCT FROM
          ROW(OLD.network,OLD.contract,OLD.batch_id,OLD.ordinal,OLD.short_id,OLD.job_id,OLD.operation_id,OLD.plan)
          OR (OLD.phase IN ('activated','failed','cancelled') AND NEW.phase<>OLD.phase)
          OR (OLD.source_key IS NOT NULL AND NEW.source_key IS DISTINCT FROM OLD.source_key) THEN
          RAISE EXCEPTION 'Backfill item identity is immutable' USING ERRCODE='SH409'; END IF;
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_backfill_identity_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_backfill_identity BEFORE UPDATE OR DELETE ON ${s}.shorts_backfill_batches
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_backfill_identity_guard();
    CREATE TRIGGER shorts_backfill_identity BEFORE UPDATE OR DELETE ON ${s}.shorts_backfill_items
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_backfill_identity_guard();
    CREATE TRIGGER shorts_backfill_no_truncate BEFORE TRUNCATE ON ${s}.shorts_backfill_batches
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_backfill_identity_guard();
    CREATE TRIGGER shorts_backfill_no_truncate BEFORE TRUNCATE ON ${s}.shorts_backfill_items
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_backfill_identity_guard();
    CREATE FUNCTION ${s}.shorts_backfill_work_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $work$
    DECLARE item ${s}.shorts_backfill_items%ROWTYPE; batch ${s}.shorts_backfill_batches%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='shorts_ingestion' THEN
        SELECT * INTO item FROM ${s}.shorts_backfill_items WHERE network=NEW.network AND contract=NEW.contract AND job_id=NEW.id;
      ELSE
        SELECT * INTO item FROM ${s}.shorts_backfill_items WHERE operation_id=NEW.operation_id;
      END IF;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT * INTO batch FROM ${s}.shorts_backfill_batches WHERE network=item.network AND contract=item.contract AND id=item.batch_id FOR SHARE;
      IF batch.status<>'running' OR batch.lease_until IS NULL OR batch.lease_until<=clock_timestamp()
        OR batch.created_at<=clock_timestamp()-interval '24 hours'
        OR item.phase IN ('activated','failed','cancelled') OR item.network<>NEW.network OR item.contract<>NEW.contract
        OR EXISTS(SELECT FROM ${s}.shorts_retention_holds WHERE network=item.network AND contract=item.contract
          AND resource_id=item.short_id AND released_at IS NULL) THEN
        RAISE EXCEPTION 'Backfill work is no longer authorized' USING ERRCODE='SH409'; END IF;
      IF TG_TABLE_NAME='shorts_ingestion' THEN
        IF NEW.delivery_short_id IS DISTINCT FROM item.short_id THEN RAISE EXCEPTION 'Backfill target changed' USING ERRCODE='SH409'; END IF;
      ELSE
        IF item.phase<>'ready' OR NEW.short_id<>item.short_id OR NEW.kind<>'activate'
          OR NEW.source_key IS DISTINCT FROM item.source_key
          OR NOT EXISTS(SELECT FROM ${s}.shorts_delivery_packages p WHERE p.network=item.network AND p.contract=item.contract
            AND p.short_id=item.short_id AND p.source_key=NEW.source_key AND p.generation_job_id=item.job_id)
          OR NEW.from_source_key IS DISTINCT FROM item.plan#>>'{expected,sourceKey}'
          OR NEW.revision::bigint<>(item.plan#>>'{expected,revision}')::bigint+1 THEN
          RAISE EXCEPTION 'Backfill selection changed' USING ERRCODE='SH409'; END IF;
      END IF;
      RETURN NEW;
    END $work$;
    REVOKE ALL ON FUNCTION ${s}.shorts_backfill_work_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_backfill_work BEFORE INSERT ON ${s}.shorts_ingestion FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_backfill_work_guard();
    CREATE TRIGGER shorts_backfill_work BEFORE INSERT ON ${s}.shorts_delivery_selections FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_backfill_work_guard()`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_backfill_batches,shorts_backfill_items IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_backfill_batches) AS used',
    );
    if (used) throw new Error('Preserve backfill history before rollback');
    await db.query(`DROP TRIGGER shorts_backfill_work ON shorts_ingestion;
      DROP TRIGGER shorts_backfill_work ON shorts_delivery_selections;
      DROP FUNCTION shorts_backfill_work_guard();
      DROP TABLE shorts_backfill_items,shorts_backfill_batches;
      DROP FUNCTION shorts_backfill_identity_guard()`);
  }
}
