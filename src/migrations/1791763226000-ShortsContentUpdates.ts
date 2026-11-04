import { MigrationInterface, QueryRunner } from 'typeorm';

/** Content and chain updates share the existing scoped live-update channel. */
export class ShortsContentUpdates1791763226000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await runner.query(`CREATE FUNCTION ${s}.shorts_content_updated() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $updates$
      BEGIN
        IF TG_OP='UPDATE' AND OLD.body IS NOT DISTINCT FROM NEW.body THEN RETURN NEW; END IF;
        IF TG_OP='DELETE' THEN
          PERFORM pg_notify('shorts_updated',json_build_object('network',OLD.network,'contract',OLD.contract)::text);
          RETURN OLD;
        END IF;
        PERFORM pg_notify('shorts_updated',json_build_object('network',NEW.network,'contract',NEW.contract)::text);
        RETURN NEW;
      END $updates$;
      REVOKE ALL ON FUNCTION ${s}.shorts_content_updated() FROM PUBLIC;
      CREATE TRIGGER shorts_content_updated AFTER INSERT OR UPDATE OF body OR DELETE ON ${s}.shorts_content
        FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_content_updated()`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TRIGGER shorts_content_updated ON shorts_content');
    await runner.query('DROP FUNCTION shorts_content_updated()');
  }
}
