import { MigrationInterface, QueryRunner } from 'typeorm';

/** Bound unpins retain their barrier until a fresh healthy-node observation. */
export class ShortsReclamationRelease1793232001000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_input_reclamation_releases (
      operation_id uuid PRIMARY KEY REFERENCES ${s}.shorts_input_reclamation_permits(operation_id),
      input_cid text NOT NULL,
      node_peer_id text NOT NULL,
      node_epoch text NOT NULL,
      observed_at timestamptz NOT NULL,
      observed_pin boolean NOT NULL,
      clock_guard_version integer NOT NULL CHECK(clock_guard_version=1),
      released_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    REVOKE ALL ON ${s}.shorts_input_reclamation_releases FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_input_reclamation_release_proof_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    DECLARE permit ${s}.shorts_input_reclamation_permits%ROWTYPE; reservation record; at timestamptz;
    BEGIN
      IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION 'Reclamation release history is immutable' USING ERRCODE='SH409';
      END IF;
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Reclamation release requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      SELECT * INTO permit FROM ${s}.shorts_input_reclamation_permits WHERE operation_id=NEW.operation_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Reclamation permit missing' USING ERRCODE='SH409'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||permit.input_cid,0));
      SELECT * INTO permit FROM ${s}.shorts_input_reclamation_permits WHERE operation_id=NEW.operation_id;
      at=clock_timestamp();
      IF permit.state NOT IN ('removed','not-pinned','rejected') OR permit.node_epoch IS NULL OR
        ROW(NEW.input_cid,NEW.node_peer_id,NEW.node_epoch) IS DISTINCT FROM
        ROW(permit.input_cid,permit.node_peer_id,permit.node_epoch) OR
        permit.quiet_until>at OR NEW.observed_at<permit.quiet_until OR
        abs(extract(epoch FROM (NEW.observed_at-at)))>5 OR
        (permit.state<>'rejected' AND NEW.observed_pin) THEN
        RAISE EXCEPTION 'Known quiescent storage outcome required' USING ERRCODE='SH409';
      END IF;
      SELECT * INTO reservation FROM ${s}.shorts_input_reclamation_reservations WHERE operation_id=permit.reservation_id;
      IF reservation.state='released' OR ${s}.shorts_input_reclamation_roots(permit.input_cid) IS DISTINCT FROM reservation.roots THEN
        RAISE EXCEPTION 'Reclamation references or policy changed' USING ERRCODE='SH409';
      END IF;
      NEW.released_at=at;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_input_reclamation_release_proof_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_input_reclamation_release_proof_guard BEFORE INSERT OR UPDATE OR DELETE
      ON ${s}.shorts_input_reclamation_releases FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_input_reclamation_release_proof_guard();
    CREATE TRIGGER shorts_input_reclamation_release_proof_no_truncate BEFORE TRUNCATE
      ON ${s}.shorts_input_reclamation_releases FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_input_reclamation_release_proof_guard();
    CREATE FUNCTION ${s}.shorts_input_reclamation_require_proof() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF NEW.state='released' AND OLD.state<>'released' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.input_cid,0));
        IF EXISTS(SELECT FROM ${s}.shorts_input_reclamation_permits p
          WHERE p.reservation_id=NEW.operation_id AND p.node_epoch IS NOT NULL AND NOT EXISTS(
            SELECT FROM ${s}.shorts_input_reclamation_releases r WHERE r.operation_id=p.operation_id
            AND r.released_at>=clock_timestamp()-interval '5 seconds')) THEN
          RAISE EXCEPTION 'Fresh storage release proof required' USING ERRCODE='SH409';
        END IF;
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_input_reclamation_require_proof() FROM PUBLIC;
    CREATE TRIGGER shorts_input_reclamation_00_proof BEFORE UPDATE ON ${s}.shorts_input_reclamation_reservations
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_input_reclamation_require_proof();
    CREATE FUNCTION ${s}.shorts_input_reclamation_atomic_release() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF NOT EXISTS(SELECT FROM ${s}.shorts_input_reclamation_permits p
        JOIN ${s}.shorts_input_reclamation_reservations r ON r.operation_id=p.reservation_id
        WHERE p.operation_id=NEW.operation_id AND r.state='released') THEN
        RAISE EXCEPTION 'Release proof and barrier release must commit together' USING ERRCODE='SH409';
      END IF;
      RETURN NULL;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_input_reclamation_atomic_release() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER shorts_input_reclamation_atomic_release AFTER INSERT ON ${s}.shorts_input_reclamation_releases
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_input_reclamation_atomic_release()`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_input_reclamation_releases,shorts_input_reclamation_permits IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] =
      await db.query(`SELECT EXISTS(SELECT FROM shorts_input_reclamation_releases)
      OR EXISTS(SELECT FROM shorts_input_reclamation_permits WHERE node_epoch IS NOT NULL) AS used`);
    if (used)
      throw new Error(
        'Preserve bound reclamation and release history before rollback',
      );
    await db.query(`DROP TRIGGER shorts_input_reclamation_00_proof ON shorts_input_reclamation_reservations;
      DROP FUNCTION shorts_input_reclamation_require_proof(); DROP TABLE shorts_input_reclamation_releases;
      DROP FUNCTION shorts_input_reclamation_release_proof_guard(); DROP FUNCTION shorts_input_reclamation_atomic_release()`);
  }
}
