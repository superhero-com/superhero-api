import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable ingress reservations. Expiry, failure and withdrawal never refund storage. */
export class ShortsUploadBudget1791763224000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await runner.query(`LOCK TABLE ${s}.shorts_runtime,${s}.shorts_upload_sessions,
      ${s}.shorts_ingestion,${s}.shorts_content IN SHARE ROW EXCLUSIVE MODE`);
    await runner.query(`CREATE TABLE ${s}.shorts_upload_budgets (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      max_uploads bigint NOT NULL DEFAULT 50 CHECK(max_uploads BETWEEN 1 AND 1000000),
      max_source_bytes bigint NOT NULL DEFAULT 2097152000 CHECK(max_source_bytes BETWEEN 1 AND 1000000000000000),
      used_uploads bigint NOT NULL DEFAULT 0 CHECK(used_uploads>=0),
      used_source_bytes bigint NOT NULL DEFAULT 0 CHECK(used_source_bytes>=0),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract),
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_runtime(network,contract)
    );
    CREATE TABLE ${s}.shorts_upload_reservations (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      creator varchar(100) NOT NULL, source_bytes bigint NOT NULL CHECK(source_bytes>0),
      declared_source_bytes bigint CHECK(declared_source_bytes>0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_upload_budgets(network,contract)
    );
    INSERT INTO ${s}.shorts_upload_budgets(network,contract) SELECT network,contract FROM ${s}.shorts_runtime`);
    await runner.query(`DO $verify$ BEGIN
      IF EXISTS(SELECT 1 FROM (
        SELECT network,contract,id,creator FROM ${s}.shorts_upload_sessions
        UNION ALL SELECT network,contract,id,creator FROM ${s}.shorts_ingestion
        UNION ALL SELECT network,contract,id,creator FROM ${s}.shorts_content
      ) identities GROUP BY network,contract,id HAVING count(DISTINCT creator)>1)
      OR EXISTS(SELECT 1 FROM (
        SELECT network,contract,id,(input->>'bytes')::bigint AS bytes FROM ${s}.shorts_upload_sessions
        UNION ALL SELECT network,contract,id,(input->>'bytes')::bigint FROM ${s}.shorts_ingestion
        UNION ALL SELECT network,contract,id,(body#>>'{privateMedia,source,bytes}')::bigint FROM ${s}.shorts_content
      ) sources GROUP BY network,contract,id HAVING count(DISTINCT bytes)>1) THEN
        RAISE EXCEPTION 'Resolve inconsistent upload identities before reserving capacity';
      END IF;
    END $verify$`);
    // Only the offline migration walks historical rows. Prefer declared source
    // size; a legacy package without a source reference is charged its package size.
    await runner.query(`INSERT INTO ${s}.shorts_upload_reservations(network,contract,id,creator,source_bytes,declared_source_bytes)
      SELECT DISTINCT ON(network,contract,id) network,contract,id,creator,bytes,declared_bytes FROM (
        SELECT network,contract,id,creator,(input->>'bytes')::bigint AS bytes,(input->>'bytes')::bigint AS declared_bytes,1 AS priority FROM ${s}.shorts_upload_sessions
        UNION ALL SELECT network,contract,id,creator,(input->>'bytes')::bigint,(input->>'bytes')::bigint,2 FROM ${s}.shorts_ingestion
        UNION ALL SELECT network,contract,id,creator,
          COALESCE(body#>>'{privateMedia,source,bytes}',body->>'bytes')::bigint,
          (body#>>'{privateMedia,source,bytes}')::bigint,3 FROM ${s}.shorts_content
      ) sources ORDER BY network,contract,id,priority;
      UPDATE ${s}.shorts_upload_budgets b SET used_uploads=n.uploads,used_source_bytes=n.bytes
      FROM (SELECT network,contract,count(*) AS uploads,sum(source_bytes) AS bytes
        FROM ${s}.shorts_upload_reservations GROUP BY network,contract) n
      WHERE b.network=n.network AND b.contract=n.contract`);
    await runner.query(`CREATE FUNCTION ${s}.shorts_upload_budget_initialize() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $init$
      BEGIN
        INSERT INTO ${s}.shorts_upload_budgets(network,contract) VALUES(NEW.network,NEW.contract);
        RETURN NEW;
      END $init$;
      REVOKE ALL ON FUNCTION ${s}.shorts_upload_budget_initialize() FROM PUBLIC;
      CREATE TRIGGER shorts_upload_budget_initialize AFTER INSERT ON ${s}.shorts_runtime
        FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_upload_budget_initialize()`);
    await runner.query(`CREATE FUNCTION ${s}.shorts_reserve_upload() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $reserve$
      DECLARE existing ${s}.shorts_upload_reservations%ROWTYPE; declared_bytes bigint; charged_bytes bigint; extra_bytes bigint;
        budget ${s}.shorts_upload_budgets%ROWTYPE;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'Upload admission requires READ COMMITTED' USING ERRCODE='SH400';
        END IF;
        IF TG_TABLE_NAME='shorts_content' THEN
          declared_bytes=(NEW.body#>>'{privateMedia,source,bytes}')::bigint;
          charged_bytes=COALESCE(declared_bytes,(NEW.body->>'bytes')::bigint);
        ELSE declared_bytes=(NEW.input->>'bytes')::bigint; charged_bytes=declared_bytes; END IF;
        IF charged_bytes IS NULL OR charged_bytes<1 OR declared_bytes<1 THEN
          RAISE EXCEPTION 'Invalid upload size' USING ERRCODE='SH400';
        END IF;
        -- This lock never acquires runtime or job rows. Worker completion can
        -- reuse its reservation without taking the API's admission locks.
        SELECT * INTO budget FROM ${s}.shorts_upload_budgets
          WHERE network=NEW.network AND contract=NEW.contract FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Upload budget missing' USING ERRCODE='SH509'; END IF;
        SELECT * INTO existing FROM ${s}.shorts_upload_reservations
          WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.id;
        IF FOUND THEN
          IF existing.creator<>NEW.creator OR (declared_bytes IS NOT NULL AND existing.declared_source_bytes IS NOT NULL
            AND existing.declared_source_bytes<>declared_bytes) THEN
            RAISE EXCEPTION 'Upload reservation identity differs' USING ERRCODE='SH409';
          END IF;
          -- Offline migration can import prepared content before its original
          -- upload. Bind the newly known source size without refunding estimates.
          IF declared_bytes IS NOT NULL AND existing.declared_source_bytes IS NULL THEN
            extra_bytes=GREATEST(declared_bytes-existing.source_bytes,0);
            IF extra_bytes>0 AND extra_bytes>budget.max_source_bytes-budget.used_source_bytes THEN
              RAISE EXCEPTION 'Upload budget exhausted' USING ERRCODE='SH509';
            END IF;
            UPDATE ${s}.shorts_upload_reservations SET declared_source_bytes=declared_bytes,
              source_bytes=source_bytes+extra_bytes WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.id;
            UPDATE ${s}.shorts_upload_budgets SET used_source_bytes=used_source_bytes+extra_bytes,updated_at=clock_timestamp()
              WHERE network=NEW.network AND contract=NEW.contract;
          END IF;
          RETURN NEW;
        END IF;
        IF budget.used_uploads>=budget.max_uploads OR charged_bytes>budget.max_source_bytes-budget.used_source_bytes THEN
          RAISE EXCEPTION 'Upload budget exhausted' USING ERRCODE='SH509';
        END IF;
        INSERT INTO ${s}.shorts_upload_reservations(network,contract,id,creator,source_bytes,declared_source_bytes)
          VALUES(NEW.network,NEW.contract,NEW.id,NEW.creator,charged_bytes,declared_bytes);
        UPDATE ${s}.shorts_upload_budgets SET used_uploads=used_uploads+1,
          used_source_bytes=used_source_bytes+charged_bytes,updated_at=clock_timestamp()
          WHERE network=NEW.network AND contract=NEW.contract;
        RETURN NEW;
      END $reserve$;
      REVOKE ALL ON FUNCTION ${s}.shorts_reserve_upload() FROM PUBLIC`);
    for (const table of [
      'shorts_upload_sessions',
      'shorts_ingestion',
      'shorts_content',
    ])
      // AFTER INSERT skips ON CONFLICT DO NOTHING rows. Rejection still rolls
      // back the entire acceptance, before the caller can write private objects.
      await runner.query(`CREATE TRIGGER shorts_reserve_upload AFTER INSERT ON ${s}.${table}
        FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_reserve_upload()`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`LOCK TABLE shorts_runtime,shorts_upload_sessions,shorts_ingestion,
      shorts_content,shorts_upload_budgets,shorts_upload_reservations IN SHARE ROW EXCLUSIVE MODE`);
    await runner.query(`DO $guard$ BEGIN
      IF EXISTS(SELECT FROM shorts_upload_reservations) THEN
        RAISE EXCEPTION 'Preserve upload reservations; do not downgrade an admitted deployment';
      END IF;
    END $guard$`);
    for (const table of [
      'shorts_upload_sessions',
      'shorts_ingestion',
      'shorts_content',
    ])
      await runner.query(`DROP TRIGGER shorts_reserve_upload ON ${table}`);
    await runner.query(`DROP TRIGGER shorts_upload_budget_initialize ON shorts_runtime;
      DROP FUNCTION shorts_reserve_upload(); DROP FUNCTION shorts_upload_budget_initialize();
      DROP TABLE shorts_upload_reservations; DROP TABLE shorts_upload_budgets`);
  }
}
