import { MigrationInterface, QueryRunner } from 'typeorm';

/** Enforce admission at the row transition, including restricted worker RPCs. */
export class ShortsProcessingCapacity1791763215000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await runner.query(`ALTER TABLE ${s}.shorts_runtime ADD COLUMN max_processing integer
      NOT NULL DEFAULT 2 CHECK(max_processing BETWEEN 1 AND 32)`);
    await runner.query(`CREATE FUNCTION ${s}.shorts_processing_capacity()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $capacity$
      DECLARE capacity integer; active integer;
      BEGIN
        IF NEW.status<>'processing' THEN RETURN NEW; END IF;
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'Processing admission requires READ COMMITTED' USING ERRCODE='SH400';
        END IF;
        IF TG_OP='UPDATE' AND OLD.status='processing'
          AND NEW.network=OLD.network AND NEW.contract=OLD.contract AND NEW.id=OLD.id
          AND NEW.lease_token=OLD.lease_token AND NEW.fence=OLD.fence THEN
          -- Expiring an existing claim is allowed. Renewal cannot revive it.
          IF NEW.lease_until<=clock_timestamp() THEN RETURN NEW; END IF;
          IF OLD.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
          RETURN NEW;
        END IF;
        IF NEW.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
        -- No queue of blocked claim queries. A busy namespace retries on the
        -- worker's normal poll; its job attempt/fence is not consumed.
        IF NOT pg_try_advisory_xact_lock(hashtextextended(
          'shorts:processing:'||NEW.network||':'||NEW.contract,0)) THEN RETURN NULL; END IF;
        SELECT max_processing INTO capacity FROM ${s}.shorts_runtime
          WHERE network=NEW.network AND contract=NEW.contract;
        IF capacity IS NULL THEN RAISE EXCEPTION 'Unknown processing deployment' USING ERRCODE='SH400'; END IF;
        SELECT count(*) INTO active FROM (SELECT 1 FROM ${s}.shorts_ingestion
          WHERE network=NEW.network AND contract=NEW.contract
            AND status='processing' AND lease_until>clock_timestamp() LIMIT capacity) current_claims;
        IF active>=capacity THEN RETURN NULL; END IF;
        RETURN NEW;
      END $capacity$`);
    await runner.query(`REVOKE ALL ON FUNCTION ${s}.shorts_processing_capacity() FROM PUBLIC;
      CREATE TRIGGER shorts_processing_capacity BEFORE INSERT OR UPDATE ON ${s}.shorts_ingestion
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_processing_capacity()`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TRIGGER shorts_processing_capacity ON shorts_ingestion',
    );
    await runner.query('DROP FUNCTION shorts_processing_capacity()');
    await runner.query('ALTER TABLE shorts_runtime DROP COLUMN max_processing');
  }
}
