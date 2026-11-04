import { MigrationInterface, QueryRunner } from 'typeorm';

/** A crash cannot silently turn an outstanding IPFS import into delete authority. */
export class ShortsPinTransfers1793145610000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_pin_transfers (
      operation_id uuid PRIMARY KEY,
      cid text NOT NULL CHECK(cid ~ '^b[a-z2-7]{20,118}$'),
      network text NOT NULL CHECK(length(network) BETWEEN 1 AND 100),
      contract text NOT NULL CHECK(length(contract) BETWEEN 1 AND 200),
      job_id text NOT NULL CHECK(job_id ~ '^[a-zA-Z0-9_-]{1,200}$'),
      purpose text NOT NULL CHECK(purpose IN ('original','assets','inputs','legacy','hls')),
      source_key text CHECK(source_key ~ '^[a-f0-9]{64}$'),
      state text NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','pinned','rejected','uncertain')),
      issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      quiet_until timestamptz NOT NULL DEFAULT clock_timestamp(),
      settled_at timestamptz,
      CHECK((purpose='hls')=(source_key IS NOT NULL))
    );
    CREATE INDEX shorts_pin_transfers_cid ON ${s}.shorts_pin_transfers(cid,state,quiet_until);
    REVOKE ALL ON ${s}.shorts_pin_transfers FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_pin_transfer_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF TG_OP IN ('DELETE','TRUNCATE') THEN
        RAISE EXCEPTION 'Pin transfer history is immutable' USING ERRCODE='SH409';
      END IF;
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Pin transfer requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.cid,0));
      IF TG_OP='INSERT' THEN
        IF NEW.state<>'issued' OR NEW.settled_at IS NOT NULL OR
          EXISTS(SELECT FROM ${s}.shorts_input_reclamation_reservations WHERE input_cid=NEW.cid AND state<>'released') THEN
          RAISE EXCEPTION 'Pin transfer conflicts with input reclamation' USING ERRCODE='SH409';
        END IF;
        NEW.issued_at=clock_timestamp();
        NEW.expires_at=NEW.issued_at+interval '180 seconds';
        NEW.quiet_until=NEW.expires_at+interval '30 seconds';
      ELSE
        IF ROW(NEW.operation_id,NEW.cid,NEW.network,NEW.contract,NEW.job_id,NEW.purpose,NEW.source_key,
          NEW.issued_at,NEW.expires_at,NEW.quiet_until) IS DISTINCT FROM
          ROW(OLD.operation_id,OLD.cid,OLD.network,OLD.contract,OLD.job_id,OLD.purpose,OLD.source_key,
          OLD.issued_at,OLD.expires_at,OLD.quiet_until) THEN
          RAISE EXCEPTION 'Pin transfer identity is immutable' USING ERRCODE='SH409';
        END IF;
        IF NEW.state=OLD.state THEN
          IF NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
            RAISE EXCEPTION 'Pin transfer receipt is immutable' USING ERRCODE='SH409';
          END IF;
          RETURN NEW;
        END IF;
        IF OLD.state<>'issued' OR NEW.state='issued' OR
          (NEW.state='pinned' AND clock_timestamp()>=OLD.expires_at) THEN
          RAISE EXCEPTION 'Pin transfer authority expired or already settled' USING ERRCODE='SH409';
        END IF;
        NEW.settled_at=clock_timestamp();
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_pin_transfer_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_pin_transfer_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_pin_transfers
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_pin_transfer_guard();
    CREATE TRIGGER shorts_pin_transfer_no_truncate BEFORE TRUNCATE ON ${s}.shorts_pin_transfers
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_pin_transfer_guard();
    CREATE FUNCTION ${s}.shorts_reclamation_transfer_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Input reclamation requires READ COMMITTED' USING ERRCODE='SH409';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.input_cid,0));
      IF EXISTS(SELECT FROM ${s}.shorts_pin_transfers WHERE cid=NEW.input_cid
        AND (state IN ('issued','uncertain') OR quiet_until>clock_timestamp())) THEN
        RAISE EXCEPTION 'Input still has outstanding pin transfers' USING ERRCODE='SH409';
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_reclamation_transfer_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_input_reclamation_0_transfers BEFORE INSERT ON ${s}.shorts_input_reclamation_reservations
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_reclamation_transfer_guard()`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query('LOCK TABLE shorts_pin_transfers IN ACCESS EXCLUSIVE MODE');
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_pin_transfers) AS used',
    );
    if (used) throw new Error('Preserve pin transfer history before rollback');
    await db.query(`DROP TRIGGER shorts_input_reclamation_0_transfers ON shorts_input_reclamation_reservations;
      DROP FUNCTION shorts_reclamation_transfer_guard(); DROP TABLE shorts_pin_transfers;
      DROP FUNCTION shorts_pin_transfer_guard()`);
  }
}
