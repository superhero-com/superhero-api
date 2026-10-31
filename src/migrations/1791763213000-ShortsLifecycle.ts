import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsLifecycle1791763213000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await runner.query(`CREATE TABLE ${s}.shorts_lifecycle_jobs (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
      fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
      lease_token uuid, lease_until timestamptz,
      next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 16),
      checked_at timestamptz,
      result varchar(24) CHECK(result IN ('checked','publication_pending','retention_pending','reconciliation_required','failed')),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract,id) REFERENCES ${s}.shorts_content(network,contract,id) ON DELETE CASCADE,
      CHECK((lease_token IS NULL)=(lease_until IS NULL))
    );
    CREATE INDEX shorts_lifecycle_due ON ${s}.shorts_lifecycle_jobs(network,contract,next_at,id)`);
    await runner.query(`CREATE FUNCTION ${s}.shorts_schedule_lifecycle() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $lifecycle$
      BEGIN
        IF TG_OP='UPDATE' AND
          jsonb_build_array(OLD.body->'publication',OLD.body->'moderation',OLD.body->'safety',
            OLD.body->'visualReviewHash',OLD.body->'scanGeneration') IS NOT DISTINCT FROM
          jsonb_build_array(NEW.body->'publication',NEW.body->'moderation',NEW.body->'safety',
            NEW.body->'visualReviewHash',NEW.body->'scanGeneration') THEN RETURN NEW; END IF;
        INSERT INTO ${s}.shorts_lifecycle_jobs(network,contract,id) VALUES(NEW.network,NEW.contract,NEW.id)
          ON CONFLICT(network,contract,id) DO UPDATE SET generation=${s}.shorts_lifecycle_jobs.generation+1,
            lease_token=NULL,lease_until=NULL,next_at=clock_timestamp(),attempts=0,result=NULL;
        RETURN NEW;
      END $lifecycle$;
      REVOKE ALL ON FUNCTION ${s}.shorts_schedule_lifecycle() FROM PUBLIC;
      CREATE TRIGGER shorts_schedule_lifecycle AFTER INSERT OR UPDATE OF body ON ${s}.shorts_content
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_schedule_lifecycle();
      INSERT INTO ${s}.shorts_lifecycle_jobs(network,contract,id) SELECT network,contract,id FROM ${s}.shorts_content`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TRIGGER shorts_schedule_lifecycle ON shorts_content',
    );
    await runner.query('DROP FUNCTION shorts_schedule_lifecycle()');
    await runner.query('DROP TABLE shorts_lifecycle_jobs');
  }
}
