import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsDeliveryStaging1793145606000 implements MigrationInterface {
  private async boundary(db: QueryRunner, reverse: boolean) {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    const before =
      "AND (delivery_short_id IS NULL OR payload->'mediaProtocol'='3'::jsonb)";
    const after = `AND NOT EXISTS(SELECT FROM ${s}.shorts_delivery_staging stage
            WHERE stage.network=binding.network AND stage.contract=binding.contract AND stage.job_id=shorts_ingestion.id AND stage.state<>'ready') ${before}`;
    const [{ definition }] = await db.query(
      "SELECT pg_get_functiondef('shorts_media_worker(text,jsonb)'::regprocedure) AS definition",
    );
    const from = reverse ? after : before,
      to = reverse ? before : after;
    if (definition.split(from).length !== 2)
      throw new Error('Unexpected original staging predecessor');
    await db.query(definition.replace(from, to));
    const [{ definition: guard }] = await db.query(
      "SELECT pg_get_functiondef('shorts_delivery_job_guard()'::regprocedure) AS definition",
    );
    const oldGuard = `          RETURN NEW;
        END IF;
        IF NEW.delivery_short_id IS NULL THEN RETURN NEW; END IF;`;
    const newGuard = `          IF OLD.delivery_short_id IS NOT NULL AND OLD.status NOT IN ('queued','processing') AND NEW.status IN ('queued','processing') THEN
            PERFORM 1 FROM ${s}.shorts_content WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.delivery_short_id FOR UPDATE;
            IF EXISTS(SELECT FROM ${s}.shorts_ingestion WHERE network=NEW.network AND contract=NEW.contract AND delivery_short_id=NEW.delivery_short_id
              AND id<>NEW.id AND status IN ('queued','processing')) THEN RAISE EXCEPTION 'Delivery preparation already pending' USING ERRCODE='SH409'; END IF;
          END IF;
${oldGuard}`;
    const guardFrom = reverse ? newGuard : oldGuard,
      guardTo = reverse ? oldGuard : newGuard;
    if (guard.split(guardFrom).length !== 2)
      throw new Error('Unexpected delivery retry predecessor');
    await db.query(guard.replace(guardFrom, guardTo));
  }
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_delivery_staging (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,job_id varchar(80) NOT NULL,
      manifest text NOT NULL CHECK(octet_length(manifest) BETWEEN 1 AND 32768),
      state varchar(8) NOT NULL CHECK(state IN ('staging','ready','failed')),
      fence bigint NOT NULL CHECK(fence>0),attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 3),
      lease_token uuid,lease_until timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,job_id),
      FOREIGN KEY(network,contract,job_id) REFERENCES ${s}.shorts_ingestion(network,contract,id),
      CHECK((state='staging')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
      CHECK(state='staging' OR (lease_token IS NULL AND lease_until IS NULL))
    );
    REVOKE ALL ON ${s}.shorts_delivery_staging FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_delivery_staging_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      DECLARE job ${s}.shorts_ingestion%ROWTYPE; body jsonb; part jsonb; n integer=0;
      BEGIN
        IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Preserve original staging references' USING ERRCODE='SH409'; END IF;
        IF TG_OP='UPDATE' THEN
          IF OLD.state='ready' OR ROW(OLD.network,OLD.contract,OLD.job_id,OLD.manifest) IS DISTINCT FROM ROW(NEW.network,NEW.contract,NEW.job_id,NEW.manifest) THEN
            RAISE EXCEPTION 'Original staging identity is immutable' USING ERRCODE='SH409';
          END IF;
          IF NEW.state='staging' THEN
            IF (OLD.state='staging' AND OLD.lease_until>clock_timestamp()) OR NEW.fence<>OLD.fence+1 OR NEW.attempts<>OLD.attempts+1
              OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN RAISE EXCEPTION 'Original staging lease is active' USING ERRCODE='SH409'; END IF;
          ELSIF OLD.state<>'staging' OR NEW.fence<>OLD.fence OR NEW.attempts<>OLD.attempts
            OR (NEW.state='ready' AND OLD.lease_until<=clock_timestamp()) THEN
            RAISE EXCEPTION 'Original staging lease changed' USING ERRCODE='SH409';
          END IF;
        ELSIF NEW.state<>'staging' OR NEW.fence<>1 OR NEW.attempts<>1 THEN
          RAISE EXCEPTION 'Invalid initial staging lease' USING ERRCODE='SH400';
        END IF;
        IF NEW.state='staging' AND (NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '180 seconds') THEN
          RAISE EXCEPTION 'Invalid staging deadline' USING ERRCODE='SH400';
        END IF;
        SELECT * INTO job FROM ${s}.shorts_ingestion WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.job_id FOR UPDATE;
        IF NOT FOUND OR job.delivery_short_id IS NULL OR job.status<>'queued' OR job.attempts<>0 OR job.fence<>0 THEN
          RAISE EXCEPTION 'Staging requires an unclaimed replacement job' USING ERRCODE='SH409';
        END IF;
        body=NEW.manifest::jsonb;
        IF body->'version' IS DISTINCT FROM '1'::jsonb OR body->>'id' IS DISTINCT FROM job.id OR body->>'creator' IS DISTINCT FROM job.creator
          OR body->'bytes' IS DISTINCT FROM job.input->'bytes' OR body->'sha256' IS DISTINCT FROM job.input->'sha256'
          OR job.input->'manifest'->>'key' IS DISTINCT FROM job.input->>'objectKey'
          OR job.input->'manifest'->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(NEW.manifest,'UTF8')),'hex')
          OR (job.input->'manifest'->>'bytes')::integer IS DISTINCT FROM octet_length(NEW.manifest)
          OR jsonb_typeof(body->'parts') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid reserved source manifest' USING ERRCODE='SH400'; END IF;
        IF jsonb_array_length(body->'parts')<>ceil((job.input->>'bytes')::numeric/1048576) THEN RAISE EXCEPTION 'Incomplete source manifest' USING ERRCODE='SH400'; END IF;
        FOR part IN SELECT value FROM jsonb_array_elements(body->'parts') LOOP
          IF part->'index' IS DISTINCT FROM to_jsonb(n) OR part->'object'->'bytes' IS DISTINCT FROM to_jsonb(least(1048576,(job.input->>'bytes')::bigint-n::bigint*1048576))
            OR coalesce(part->'object'->>'sha256','') !~ '^[a-f0-9]{64}$'
            OR coalesce(part->'object'->>'keyId','') !~ '^[a-zA-Z0-9_-]{1,32}$'
            OR coalesce(part->'object'->>'key','') !~ '^[a-zA-Z0-9_/-]+$' OR length(part->'object'->>'key')>512 THEN RAISE EXCEPTION 'Invalid source part' USING ERRCODE='SH400'; END IF;
          n=n+1;
        END LOOP;
        NEW.updated_at=clock_timestamp(); RETURN NEW;
      END $guard$;
      REVOKE ALL ON FUNCTION ${s}.shorts_delivery_staging_guard() FROM PUBLIC;
      CREATE TRIGGER shorts_delivery_staging_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_delivery_staging FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_delivery_staging_guard();
      CREATE TRIGGER shorts_delivery_staging_truncate BEFORE TRUNCATE ON ${s}.shorts_delivery_staging FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_delivery_staging_guard()`);
    await this.boundary(db, false);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_ingestion,shorts_delivery_staging IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_delivery_staging) AS used',
    );
    if (used)
      throw new Error('Preserve original staging history before rollback');
    await this.boundary(db, true);
    await db.query(
      'DROP TABLE shorts_delivery_staging; DROP FUNCTION shorts_delivery_staging_guard()',
    );
  }
}
