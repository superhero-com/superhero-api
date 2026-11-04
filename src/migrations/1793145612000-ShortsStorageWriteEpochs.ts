import { MigrationInterface, QueryRunner } from 'typeorm';

/** A process epoch is fixed durably before its first storage mutation is sent. */
export class ShortsStorageWriteEpochs1793145612000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE FUNCTION ${s}.shorts_storage_epoch_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    DECLARE cid text; at timestamptz; reservation record;
    BEGIN
      IF TG_TABLE_NAME='shorts_pin_transfers' THEN cid=NEW.cid; ELSE cid=NEW.input_cid; END IF;
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Storage epoch requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||cid,0));
      IF TG_OP='INSERT' THEN
        IF NEW.node_peer_id IS NOT NULL OR NEW.node_epoch IS NOT NULL OR NEW.storage_bound_at IS NOT NULL THEN
          RAISE EXCEPTION 'Issue storage authority before binding an epoch' USING ERRCODE='SH409';
        END IF;
      ELSIF ROW(NEW.node_peer_id,NEW.node_epoch,NEW.storage_bound_at) IS DISTINCT FROM
        ROW(OLD.node_peer_id,OLD.node_epoch,OLD.storage_bound_at) THEN
        at=clock_timestamp();
        IF OLD.node_epoch IS NOT NULL OR OLD.state<>'issued' OR NEW.state<>'issued' OR
          NEW.node_peer_id IS NULL OR NEW.node_epoch IS NULL OR OLD.expires_at<=at THEN
          RAISE EXCEPTION 'Storage epoch is immutable or authority expired' USING ERRCODE='SH409';
        END IF;
        IF TG_TABLE_NAME='shorts_input_reclamation_permits' THEN
          SELECT * INTO reservation FROM ${s}.shorts_input_reclamation_reservations WHERE operation_id=NEW.reservation_id;
          IF NOT FOUND OR reservation.state<>'reserved' OR
            ${s}.shorts_input_reclamation_roots(cid) IS DISTINCT FROM reservation.roots THEN
            RAISE EXCEPTION 'Reclamation policy changed before storage binding' USING ERRCODE='SH409';
          END IF;
        END IF;
        NEW.storage_bound_at=at;
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_storage_epoch_guard() FROM PUBLIC`);
    for (const table of [
      'shorts_pin_transfers',
      'shorts_input_reclamation_permits',
    ]) {
      await db.query(`ALTER TABLE ${s}.${table}
        ADD COLUMN node_peer_id text CHECK(node_peer_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,120}$'),
        ADD COLUMN node_epoch text CHECK(node_epoch ~ '^[a-f0-9]{64}$'),
        ADD COLUMN storage_bound_at timestamptz,
        ADD CONSTRAINT ${table}_epoch_pair CHECK((node_peer_id IS NULL)=(node_epoch IS NULL)
          AND (node_epoch IS NULL)=(storage_bound_at IS NULL));
        CREATE TRIGGER shorts_storage_epoch_guard BEFORE INSERT OR UPDATE ON ${s}.${table}
          FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_storage_epoch_guard()`);
    }
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_pin_transfers,shorts_input_reclamation_permits IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] =
      await db.query(`SELECT EXISTS(SELECT FROM shorts_pin_transfers WHERE node_epoch IS NOT NULL
      UNION ALL SELECT FROM shorts_input_reclamation_permits WHERE node_epoch IS NOT NULL) AS used`);
    if (used) throw new Error('Preserve storage epoch history before rollback');
    for (const table of [
      'shorts_pin_transfers',
      'shorts_input_reclamation_permits',
    ]) {
      await db.query(`DROP TRIGGER shorts_storage_epoch_guard ON ${table};
        ALTER TABLE ${table} DROP COLUMN node_peer_id,DROP COLUMN node_epoch,DROP COLUMN storage_bound_at`);
    }
    await db.query('DROP FUNCTION shorts_storage_epoch_guard()');
  }
}
