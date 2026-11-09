import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

export class ShortsProcessingAndRetention1791763215001 extends FeatureMigration {
  readonly steps = {
    /** Enforce admission at the row transition, including restricted worker RPCs. */
    ShortsProcessingCapacity: {
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
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query(
          'DROP TRIGGER shorts_processing_capacity ON shorts_ingestion',
        );
        await runner.query('DROP FUNCTION shorts_processing_capacity()');
        await runner.query(
          'ALTER TABLE shorts_runtime DROP COLUMN max_processing',
        );
      },
    },

    ShortsRetentionHolds: {
      async up(db: QueryRunner): Promise<void> {
        await db.query(`CREATE TABLE shorts_retention_holds (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      id uuid NOT NULL, resource_id varchar(80) NOT NULL,
      reason varchar(32) NOT NULL CHECK(reason IN ('legal','safety','appeal','recovery')),
      reference varchar(120) NOT NULL CHECK(reference ~ '^[a-zA-Z0-9_.:/-]{1,120}$'),
      created_by name NOT NULL DEFAULT current_user,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      released_by name, released_at timestamptz,
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      CHECK(resource_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
      CHECK((released_by IS NULL)=(released_at IS NULL)),
      CHECK(released_at IS NULL OR released_at>=created_at)
    );
    CREATE INDEX shorts_retention_active_holds ON shorts_retention_holds(network,contract,resource_id)
      WHERE released_at IS NULL;
    CREATE INDEX shorts_retention_hold_history ON shorts_retention_holds(network,contract,resource_id,created_at,id);
    CREATE INDEX shorts_retention_cid ON shorts_content((body->>'cid'),network,contract,id);`);
        await db.query(`CREATE FUNCTION shorts_preserve_retention_hold() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $hold$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retention hold history cannot be deleted'; END IF;
        IF TG_OP='INSERT' THEN
          IF NEW.created_by<>current_user OR NEW.released_at IS NOT NULL OR NEW.released_by IS NOT NULL
            THEN RAISE EXCEPTION 'Invalid retention hold identity'; END IF;
          NEW.created_at:=clock_timestamp(); RETURN NEW;
        END IF;
        IF ROW(NEW.network,NEW.contract,NEW.id,NEW.resource_id,NEW.reason,NEW.reference,NEW.created_by,NEW.created_at)
          IS DISTINCT FROM ROW(OLD.network,OLD.contract,OLD.id,OLD.resource_id,OLD.reason,OLD.reference,OLD.created_by,OLD.created_at)
          OR OLD.released_at IS NOT NULL OR NEW.released_by IS DISTINCT FROM current_user
          OR NEW.released_at IS NULL THEN RAISE EXCEPTION 'Retention holds are immutable except for one release'; END IF;
        NEW.released_at:=clock_timestamp(); RETURN NEW;
      END $hold$;
      REVOKE ALL ON FUNCTION shorts_preserve_retention_hold() FROM PUBLIC;
      CREATE TRIGGER shorts_preserve_retention_hold BEFORE INSERT OR UPDATE OR DELETE ON shorts_retention_holds
        FOR EACH ROW EXECUTE FUNCTION shorts_preserve_retention_hold();`);
      },
      async down(db: QueryRunner): Promise<void> {
        // Check under the same lock as DROP, including when a hold is being committed.
        await db.query(`DO $rollback$
      BEGIN
        LOCK TABLE shorts_retention_holds IN ACCESS EXCLUSIVE MODE;
        IF EXISTS(SELECT 1 FROM shorts_retention_holds) THEN
          RAISE EXCEPTION 'Preserve retention hold history; this migration cannot be rolled back after use';
        END IF;
        DROP TABLE shorts_retention_holds;
        DROP FUNCTION shorts_preserve_retention_hold();
        DROP INDEX shorts_retention_cid;
      END $rollback$`);
      },
    },
  };
}
