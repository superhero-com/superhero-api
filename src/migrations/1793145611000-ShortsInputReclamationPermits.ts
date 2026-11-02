import { MigrationInterface, QueryRunner } from 'typeorm';

/** An issued unpin cannot be cancelled by releasing its reference barrier. */
export class ShortsInputReclamationPermits1793145611000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_input_reclamation_permits (
      operation_id uuid PRIMARY KEY,
      reservation_id uuid NOT NULL UNIQUE REFERENCES ${s}.shorts_input_reclamation_reservations(operation_id),
      input_cid text NOT NULL CHECK(input_cid ~ '^b[a-z2-7]{20,118}$'),
      state text NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','removed','not-pinned','rejected','uncertain')),
      issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      quiet_until timestamptz NOT NULL DEFAULT clock_timestamp(),
      settled_at timestamptz
    );
    REVOKE ALL ON ${s}.shorts_input_reclamation_permits FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_input_reclamation_permit_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    DECLARE reservation ${s}.shorts_input_reclamation_reservations%ROWTYPE;
    BEGIN
      IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'Reclamation permit history is immutable' USING ERRCODE='SH409';
      END IF;
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Reclamation permit requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.input_cid,0));
      IF TG_OP='INSERT' THEN
        SELECT * INTO reservation FROM ${s}.shorts_input_reclamation_reservations WHERE operation_id=NEW.reservation_id;
        IF NOT FOUND OR reservation.state<>'reserved' OR reservation.input_cid<>NEW.input_cid
          OR NEW.state<>'issued' OR NEW.settled_at IS NOT NULL THEN
          RAISE EXCEPTION 'Reclamation reservation is not valid' USING ERRCODE='SH409';
        END IF;
        IF ${s}.shorts_input_reclamation_roots(NEW.input_cid) IS DISTINCT FROM reservation.roots THEN
          RAISE EXCEPTION 'Reclamation references changed' USING ERRCODE='SH409';
        END IF;
        NEW.issued_at=clock_timestamp(); NEW.expires_at=NEW.issued_at+interval '20 seconds';
        NEW.quiet_until=NEW.expires_at+interval '30 seconds';
      ELSE
        IF ROW(NEW.operation_id,NEW.reservation_id,NEW.input_cid,NEW.issued_at,NEW.expires_at,NEW.quiet_until)
          IS DISTINCT FROM ROW(OLD.operation_id,OLD.reservation_id,OLD.input_cid,OLD.issued_at,OLD.expires_at,OLD.quiet_until) THEN
          RAISE EXCEPTION 'Reclamation permit identity is immutable' USING ERRCODE='SH409';
        END IF;
        IF NEW.state=OLD.state THEN
          IF NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
            RAISE EXCEPTION 'Reclamation permit receipt is immutable' USING ERRCODE='SH409';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.state<>'issued' OR NEW.state='issued' THEN
          RAISE EXCEPTION 'Reclamation permit is already settled' USING ERRCODE='SH409';
        END IF;
        NEW.settled_at=clock_timestamp();
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_input_reclamation_permit_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_input_reclamation_permit_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_input_reclamation_permits
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_input_reclamation_permit_guard();
    CREATE TRIGGER shorts_input_reclamation_permit_no_truncate BEFORE TRUNCATE ON ${s}.shorts_input_reclamation_permits
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_input_reclamation_permit_guard();
    CREATE FUNCTION ${s}.shorts_input_reclamation_release_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF NEW.state<>'released' THEN RETURN NEW; END IF;
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Reclamation release requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.input_cid,0));
      IF NEW.state='released' AND EXISTS(SELECT FROM ${s}.shorts_input_reclamation_permits
        WHERE reservation_id=NEW.operation_id AND (state IN ('issued','uncertain') OR quiet_until>clock_timestamp())) THEN
        RAISE EXCEPTION 'Reclamation permit still holds its reference barrier' USING ERRCODE='SH409';
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_input_reclamation_release_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_input_reclamation_0_release BEFORE UPDATE ON ${s}.shorts_input_reclamation_reservations
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_input_reclamation_release_guard()`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_input_reclamation_permits IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_input_reclamation_permits) AS used',
    );
    if (used)
      throw new Error('Preserve reclamation permit history before rollback');
    await db.query(`DROP TRIGGER shorts_input_reclamation_0_release ON shorts_input_reclamation_reservations;
      DROP FUNCTION shorts_input_reclamation_release_guard(); DROP TABLE shorts_input_reclamation_permits;
      DROP FUNCTION shorts_input_reclamation_permit_guard()`);
  }
}
