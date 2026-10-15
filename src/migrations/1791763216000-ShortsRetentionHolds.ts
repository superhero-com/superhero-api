import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsRetentionHolds1791763216000 implements MigrationInterface {
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
  }
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
  }
}
