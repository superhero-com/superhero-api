import { MigrationInterface, QueryRunner } from 'typeorm';

/** Recovery records retire old process authority without rewriting its outcome. */
export class ShortsStorageRecovery1793232002000 implements MigrationInterface {
  private async guards(db: QueryRunner, s: string, recovery: boolean) {
    const recovered = (kind: string, alias: string) =>
      recovery
        ? `AND NOT EXISTS(SELECT FROM ${s}.shorts_storage_recoveries r WHERE r.kind='${kind}' AND r.operation_id=${alias}.operation_id)`
        : '';
    await db.query(`CREATE OR REPLACE FUNCTION ${s}.shorts_reclamation_transfer_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Input reclamation requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.input_cid,0));
      IF EXISTS(SELECT FROM ${s}.shorts_pin_transfers p WHERE p.cid=NEW.input_cid
        AND (p.state IN ('issued','uncertain') OR p.quiet_until>clock_timestamp()) ${recovered('pin', 'p')}) THEN
        RAISE EXCEPTION 'Input still has outstanding pin transfers' USING ERRCODE='SH409';
      END IF;
      RETURN NEW;
    END $guard$;
    CREATE OR REPLACE FUNCTION ${s}.shorts_input_reclamation_release_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF NEW.state<>'released' THEN RETURN NEW; END IF;
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Reclamation release requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.input_cid,0));
      IF EXISTS(SELECT FROM ${s}.shorts_input_reclamation_permits p WHERE p.reservation_id=NEW.operation_id
        AND (p.state IN ('issued','uncertain') OR p.quiet_until>clock_timestamp()) ${recovered('unpin', 'p')}) THEN
        RAISE EXCEPTION 'Reclamation permit still holds its reference barrier' USING ERRCODE='SH409';
      END IF;
      RETURN NEW;
    END $guard$;
    CREATE OR REPLACE FUNCTION ${s}.shorts_input_reclamation_require_proof() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF NEW.state='released' AND OLD.state<>'released' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.input_cid,0));
        IF EXISTS(SELECT FROM ${s}.shorts_input_reclamation_permits p
          WHERE p.reservation_id=NEW.operation_id AND p.node_epoch IS NOT NULL AND NOT EXISTS(
            SELECT FROM ${s}.shorts_input_reclamation_releases r WHERE r.operation_id=p.operation_id
            AND r.released_at>=clock_timestamp()-interval '5 seconds')
          ${
            recovery
              ? `AND NOT EXISTS(SELECT FROM ${s}.shorts_storage_recoveries r WHERE r.kind='unpin'
            AND r.operation_id=p.operation_id AND r.recorded_at>=clock_timestamp()-interval '5 seconds')`
              : ''
          }) THEN
          RAISE EXCEPTION 'Fresh storage release proof required' USING ERRCODE='SH409';
        END IF;
      END IF;
      RETURN NEW;
    END $guard$`);
  }
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_storage_recoveries (
      kind text NOT NULL CHECK(kind IN ('pin','unpin')),
      operation_id uuid NOT NULL,
      cid text NOT NULL,
      prior_state text NOT NULL,
      previous_node_epoch text NOT NULL,
      node_peer_id text NOT NULL,
      node_epoch text NOT NULL CHECK(node_epoch ~ '^[a-f0-9]{64}$'),
      observed_at timestamptz NOT NULL,
      observed_pin boolean NOT NULL,
      clock_guard_version integer NOT NULL CHECK(clock_guard_version=1),
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(kind,operation_id)
    );
    REVOKE ALL ON ${s}.shorts_storage_recoveries FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_storage_recovery_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    DECLARE authority record; reservation record; at timestamptz;
    BEGIN
      IF TG_OP<>'INSERT' THEN
        RAISE EXCEPTION 'Storage recovery history is immutable' USING ERRCODE='SH409';
      END IF;
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Storage recovery requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.cid,0));
      IF NEW.kind='pin' THEN
        SELECT cid,state,node_peer_id,node_epoch,quiet_until INTO authority
          FROM ${s}.shorts_pin_transfers WHERE operation_id=NEW.operation_id;
      ELSE
        SELECT input_cid AS cid,state,node_peer_id,node_epoch,quiet_until INTO authority
          FROM ${s}.shorts_input_reclamation_permits WHERE operation_id=NEW.operation_id;
      END IF;
      IF NOT FOUND THEN RAISE EXCEPTION 'Storage authority missing' USING ERRCODE='SH409'; END IF;
      at=clock_timestamp();
      IF authority.node_epoch IS NULL OR NEW.node_epoch=authority.node_epoch OR
        ROW(NEW.cid,NEW.prior_state,NEW.previous_node_epoch,NEW.node_peer_id) IS DISTINCT FROM
        ROW(authority.cid,authority.state,authority.node_epoch,authority.node_peer_id) OR
        authority.quiet_until>at OR NEW.observed_at<authority.quiet_until OR
        abs(extract(epoch FROM (NEW.observed_at-at)))>5 OR
        (NEW.kind='pin' AND authority.state NOT IN ('issued','uncertain')) THEN
        RAISE EXCEPTION 'Fresh recovered node and expired bound authority required' USING ERRCODE='SH409';
      END IF;
      IF NEW.kind='unpin' THEN
        SELECT r.* INTO reservation FROM ${s}.shorts_input_reclamation_reservations r
          JOIN ${s}.shorts_input_reclamation_permits p ON p.reservation_id=r.operation_id
          WHERE p.operation_id=NEW.operation_id;
        IF reservation.state='released' OR ${s}.shorts_input_reclamation_roots(NEW.cid) IS DISTINCT FROM reservation.roots THEN
          RAISE EXCEPTION 'Recovery references or policy changed' USING ERRCODE='SH409';
        END IF;
      END IF;
      NEW.recorded_at=at;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_storage_recovery_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_storage_recovery_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_storage_recoveries
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_storage_recovery_guard();
    CREATE TRIGGER shorts_storage_recovery_no_truncate BEFORE TRUNCATE ON ${s}.shorts_storage_recoveries
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_storage_recovery_guard();
    CREATE FUNCTION ${s}.shorts_recovered_write_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    DECLARE operation_kind text; cid text;
    BEGIN
      IF TG_TABLE_NAME='shorts_pin_transfers' THEN operation_kind='pin'; cid=OLD.cid;
        ELSE operation_kind='unpin'; cid=OLD.input_cid; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||cid,0));
      IF NEW IS DISTINCT FROM OLD AND EXISTS(SELECT FROM ${s}.shorts_storage_recoveries
        WHERE kind=operation_kind AND operation_id=OLD.operation_id) THEN
        RAISE EXCEPTION 'Recovered storage authority is immutable' USING ERRCODE='SH409';
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_recovered_write_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_recovered_write_guard BEFORE UPDATE ON ${s}.shorts_pin_transfers
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_recovered_write_guard();
    CREATE TRIGGER shorts_recovered_write_guard BEFORE UPDATE ON ${s}.shorts_input_reclamation_permits
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_recovered_write_guard();
    CREATE FUNCTION ${s}.shorts_storage_recovery_atomic_release() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF NEW.kind='unpin' AND NOT EXISTS(SELECT FROM ${s}.shorts_input_reclamation_permits p
        JOIN ${s}.shorts_input_reclamation_reservations r ON r.operation_id=p.reservation_id
        WHERE p.operation_id=NEW.operation_id AND r.state='released') THEN
        RAISE EXCEPTION 'Unpin recovery and barrier release must commit together' USING ERRCODE='SH409';
      END IF;
      RETURN NULL;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_storage_recovery_atomic_release() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER shorts_storage_recovery_atomic_release AFTER INSERT ON ${s}.shorts_storage_recoveries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_storage_recovery_atomic_release()`);
    await this.guards(db, s, true);
  }
  async down(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`LOCK TABLE ${s}.shorts_storage_recoveries,${s}.shorts_input_reclamation_reservations,
      ${s}.shorts_input_reclamation_permits,${s}.shorts_pin_transfers IN ACCESS EXCLUSIVE MODE`);
    const [{ used }] = await db.query(
      `SELECT EXISTS(SELECT FROM ${s}.shorts_storage_recoveries) AS used`,
    );
    if (used)
      throw new Error('Preserve storage recovery history before rollback');
    await this.guards(db, s, false);
    await db.query(`DROP TRIGGER shorts_recovered_write_guard ON ${s}.shorts_pin_transfers;
      DROP TRIGGER shorts_recovered_write_guard ON ${s}.shorts_input_reclamation_permits;
      DROP FUNCTION ${s}.shorts_recovered_write_guard(); DROP TABLE ${s}.shorts_storage_recoveries;
      DROP FUNCTION ${s}.shorts_storage_recovery_guard(); DROP FUNCTION ${s}.shorts_storage_recovery_atomic_release()`);
  }
}
