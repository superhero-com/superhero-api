import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsStreamingOutbox1791763206000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await runner.query(`CREATE TABLE ${s}.shorts_stream_jobs (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      generation bigint NOT NULL DEFAULT 1 CHECK(generation>0), cid text NOT NULL,
      ready boolean NOT NULL DEFAULT false,
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 16),
      next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_token uuid, lease_until timestamptz,
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract,id) REFERENCES ${s}.shorts_content(network,contract,id) ON DELETE CASCADE,
      CHECK((lease_token IS NULL)=(lease_until IS NULL)),
      CHECK(NOT ready OR lease_token IS NULL)
    )`);
    await runner.query(`CREATE INDEX shorts_stream_jobs_pending ON ${s}.shorts_stream_jobs(network,contract,next_at,id)
      WHERE NOT ready`);
    // Enqueue in the same transaction as publication, including imports and recovery.
    // The dispatcher and the streaming catalog still enforce the current policy.
    await runner.query(`CREATE FUNCTION ${s}.shorts_schedule_stream() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $stream$
      BEGIN
        IF NEW.body->>'publication' IS DISTINCT FROM 'published' THEN
          DELETE FROM ${s}.shorts_stream_jobs WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.id;
          RETURN NEW;
        END IF;
        IF TG_OP='UPDATE' AND
          jsonb_build_array(OLD.body->'cid',OLD.body->'bytes',OLD.body->'creator',OLD.body->'publication',
            OLD.body->'moderation',OLD.body->'safety',OLD.body->'visualReviewHash') IS NOT DISTINCT FROM
          jsonb_build_array(NEW.body->'cid',NEW.body->'bytes',NEW.body->'creator',NEW.body->'publication',
            NEW.body->'moderation',NEW.body->'safety',NEW.body->'visualReviewHash') THEN
          RETURN NEW;
        END IF;
        INSERT INTO ${s}.shorts_stream_jobs(network,contract,id,cid)
          VALUES(NEW.network,NEW.contract,NEW.id,NEW.body->>'cid')
          ON CONFLICT(network,contract,id) DO UPDATE SET
            generation=${s}.shorts_stream_jobs.generation+1,cid=excluded.cid,ready=false,
            attempts=0,next_at=clock_timestamp(),lease_token=NULL,lease_until=NULL;
        RETURN NEW;
      END $stream$`);
    await runner.query(`REVOKE ALL ON FUNCTION ${s}.shorts_schedule_stream() FROM PUBLIC;
      CREATE TRIGGER shorts_schedule_stream AFTER INSERT OR UPDATE OF body ON ${s}.shorts_content
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_schedule_stream()`);
    await runner.query(`INSERT INTO ${s}.shorts_stream_jobs(network,contract,id,cid)
      SELECT network,contract,id,body->>'cid' FROM ${s}.shorts_content WHERE body->>'publication'='published'`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TRIGGER shorts_schedule_stream ON shorts_content');
    await runner.query('DROP FUNCTION shorts_schedule_stream()');
    await runner.query('DROP TABLE shorts_stream_jobs');
  }
}
