import { MigrationInterface, QueryRunner } from 'typeorm';

/** Reuse fenced media execution without creating another post for a replacement encode. */
export class ShortsDeliveryGenerations1793145603000 implements MigrationInterface {
  private async boundary(db: QueryRunner, reverse: boolean) {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    const insert = `INSERT INTO ${s}.shorts_content(network,contract,id,creator,created_at,body)
        VALUES(binding.network,binding.contract,job.id,job.creator,(body->>'createdAt')::bigint,body);`;
    const generation = `IF job.delivery_short_id IS NULL THEN
        ${insert}
      ELSE
        INSERT INTO ${s}.shorts_delivery_generations(network,contract,job_id,short_id,fence,body)
          VALUES(binding.network,binding.contract,job.id,job.delivery_short_id,job.fence,body);
      END IF;`;
    const changes: [string, string][] = [
      [
        '"originalContentVersion":1',
        '"originalContentVersion":1,"deliveryGenerationVersion":1',
      ],
      [
        "AND (input->>'processingProfile'",
        "AND (delivery_short_id IS NULL OR payload->'mediaProtocol'='3'::jsonb) AND (input->>'processingProfile'",
      ],
      [
        "payload->'mediaProtocol'='2'::jsonb",
        "payload->'mediaProtocol' IN ('2'::jsonb,'3'::jsonb)",
      ],
      [
        'ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED',
        'ORDER BY (delivery_short_id IS NOT NULL),created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED',
      ],
      [insert, generation],
      [
        "SET status='ready',result_id=id,lease_token=NULL",
        "SET status='ready',result_id=coalesce(delivery_short_id,id),lease_token=NULL",
      ],
    ];
    const [{ definition }] = await db.query(
      'SELECT pg_get_functiondef($1::regprocedure) AS definition',
      [`${s}.shorts_media_worker(text,jsonb)`],
    );
    let sql = String(definition);
    for (const pair of reverse ? [...changes].reverse() : changes) {
      const [from, to] = reverse ? [pair[1], pair[0]] : pair;
      if (sql.split(from).length !== 2)
        throw new Error('Unexpected delivery-generation migration predecessor');
      sql = sql.replace(from, to);
    }
    await db.query(sql);
  }
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`ALTER TABLE ${s}.shorts_ingestion ADD COLUMN delivery_short_id varchar(80),
      ADD FOREIGN KEY(network,contract,delivery_short_id) REFERENCES ${s}.shorts_content(network,contract,id),
      ADD CHECK(delivery_short_id IS NULL OR (delivery_short_id<>id AND input->>'processingProfile'='original-h264-v1'));
    CREATE INDEX shorts_ingestion_delivery ON ${s}.shorts_ingestion(network,contract,delivery_short_id) WHERE delivery_short_id IS NOT NULL;
    CREATE TABLE ${s}.shorts_delivery_generations (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, job_id varchar(80) NOT NULL, short_id varchar(80) NOT NULL,
      fence bigint NOT NULL CHECK(fence>0), body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND octet_length(body::text)<=131072),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,job_id),
      FOREIGN KEY(network,contract,job_id) REFERENCES ${s}.shorts_ingestion(network,contract,id),
      FOREIGN KEY(network,contract,short_id) REFERENCES ${s}.shorts_content(network,contract,id)
    );
    CREATE INDEX shorts_delivery_generation_post ON ${s}.shorts_delivery_generations(network,contract,short_id);
    CREATE INDEX shorts_delivery_generation_input ON ${s}.shorts_delivery_generations((body->'derivatives'->>'cid'));
    CREATE INDEX shorts_delivery_generation_assets ON ${s}.shorts_delivery_generations((body->'derivatives'->>'assetsCid'));
    REVOKE ALL ON ${s}.shorts_delivery_generations FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_delivery_job_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $job$
      DECLARE original jsonb; generation_count integer;
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF OLD.delivery_short_id IS DISTINCT FROM NEW.delivery_short_id OR (OLD.delivery_short_id IS NOT NULL AND
            jsonb_build_array(OLD.network,OLD.contract,OLD.id,OLD.creator,OLD.input) IS DISTINCT FROM
            jsonb_build_array(NEW.network,NEW.contract,NEW.id,NEW.creator,NEW.input)) THEN
            RAISE EXCEPTION 'Accepted delivery job is immutable' USING ERRCODE='SH409';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.delivery_short_id IS NULL THEN RETURN NEW; END IF;
        SELECT body INTO original FROM ${s}.shorts_content WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.delivery_short_id FOR UPDATE;
        IF NOT FOUND OR NOT original ? 'original' OR NEW.id=NEW.delivery_short_id
          OR original->>'creator' IS DISTINCT FROM NEW.creator
          OR NEW.input->>'processingProfile' IS DISTINCT FROM 'original-h264-v1'
          OR NEW.input->'bytes' IS DISTINCT FROM original->'bytes'
          OR NEW.input->'sha256' IS DISTINCT FROM original->'original'->'sha256'
          OR jsonb_typeof(NEW.input->'manifest') IS DISTINCT FROM 'object'
          OR NEW.status<>'queued' OR NEW.attempts<>0 OR NEW.fence<>0
          OR EXISTS(SELECT FROM ${s}.shorts_content WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.id)
          OR EXISTS(SELECT FROM ${s}.shorts_upload_sessions WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.id) THEN
          RAISE EXCEPTION 'Invalid delivery preparation source' USING ERRCODE='SH400';
        END IF;
        PERFORM ${s}.shorts_validate_original(original);
        SELECT count(*) INTO generation_count FROM ${s}.shorts_ingestion
          WHERE network=NEW.network AND contract=NEW.contract AND delivery_short_id=NEW.delivery_short_id;
        IF generation_count>=8 THEN RAISE EXCEPTION 'Delivery generation history is full' USING ERRCODE='SH509'; END IF;
        IF EXISTS(SELECT FROM ${s}.shorts_ingestion WHERE network=NEW.network AND contract=NEW.contract
          AND delivery_short_id=NEW.delivery_short_id AND status IN ('queued','processing')) THEN
          RAISE EXCEPTION 'Delivery preparation already pending' USING ERRCODE='SH409';
        END IF;
        RETURN NEW;
      END $job$;
    REVOKE ALL ON FUNCTION ${s}.shorts_delivery_job_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_delivery_job_guard BEFORE INSERT OR UPDATE ON ${s}.shorts_ingestion
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_delivery_job_guard();
    CREATE FUNCTION ${s}.shorts_delivery_generation_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $generation$
      DECLARE job ${s}.shorts_ingestion%ROWTYPE; original jsonb;
      BEGIN
        IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Prepared delivery generation is immutable' USING ERRCODE='SH409'; END IF;
        SELECT * INTO job FROM ${s}.shorts_ingestion WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.job_id FOR UPDATE;
        IF NOT FOUND OR job.delivery_short_id IS DISTINCT FROM NEW.short_id OR job.status<>'processing'
          OR job.lease_until<=clock_timestamp() OR job.fence<>NEW.fence
          OR job.lease_principal IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=session_user)
          OR NOT EXISTS(SELECT FROM ${s}.shorts_worker_principals WHERE role_oid=job.lease_principal AND role_name=session_user
            AND network=NEW.network AND contract=NEW.contract AND enabled)
          OR NEW.body->>'id' IS DISTINCT FROM job.id OR NEW.body->>'creator' IS DISTINCT FROM job.creator
          OR NEW.body->'privateMedia'->'source' IS DISTINCT FROM job.input
          OR NEW.body->'derivatives'->'generation'->>'fence' IS DISTINCT FROM job.fence::text
          OR NEW.body->>'moderation' IS NULL OR NEW.body->>'moderation' NOT IN ('pending','rejected')
          OR NEW.body ? 'publication' THEN
          RAISE EXCEPTION 'Delivery generation claim changed' USING ERRCODE='SH409';
        END IF;
        SELECT body INTO original FROM ${s}.shorts_content WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.short_id FOR SHARE;
        IF NOT FOUND OR NEW.body->'cid' IS DISTINCT FROM original->'cid' OR NEW.body->'bytes' IS DISTINCT FROM original->'bytes'
          OR NEW.body->'original' IS DISTINCT FROM original->'original' THEN
          RAISE EXCEPTION 'Delivery generation changed original identity' USING ERRCODE='SH409';
        END IF;
        PERFORM ${s}.shorts_validate_original(NEW.body);
        NEW.created_at=clock_timestamp();
        RETURN NEW;
      END $generation$;
    REVOKE ALL ON FUNCTION ${s}.shorts_delivery_generation_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_delivery_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_delivery_generations
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_delivery_generation_guard();
    CREATE TRIGGER shorts_delivery_generation_truncate BEFORE TRUNCATE ON ${s}.shorts_delivery_generations
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_delivery_generation_guard()`);
    await this.boundary(db, false);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_ingestion,shorts_delivery_generations IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_ingestion WHERE delivery_short_id IS NOT NULL) OR EXISTS(SELECT FROM shorts_delivery_generations) AS used',
    );
    if (used)
      throw new Error('Preserve delivery generation history before rollback');
    await this.boundary(db, true);
    await db.query(`DROP TABLE shorts_delivery_generations;
      DROP FUNCTION shorts_delivery_generation_guard();
      DROP TRIGGER shorts_delivery_job_guard ON shorts_ingestion;
      DROP FUNCTION shorts_delivery_job_guard();
      ALTER TABLE shorts_ingestion DROP COLUMN delivery_short_id`);
  }
}
