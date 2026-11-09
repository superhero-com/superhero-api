import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

export class ShortsContractImports1792368000001 extends FeatureMigration {
  readonly changes = {
    /** Preserve encrypted content identities while a new contract gets its own journal. */
    ShortsPublicationContentScope1792368000000: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await db.query(`ALTER TABLE ${s}.shorts_publishing_contracts ADD COLUMN content_contract varchar(100),
      ADD FOREIGN KEY(network,content_contract) REFERENCES ${s}.shorts_runtime(network,contract);
      ALTER TABLE ${s}.shorts_publication_jobs ADD COLUMN content_contract varchar(100);
      UPDATE ${s}.shorts_publication_jobs SET content_contract=contract;
      ALTER TABLE ${s}.shorts_publication_jobs ALTER COLUMN content_contract SET NOT NULL`);
        const keys = await db.query(
          `SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass
      AND confrelid=$2::regclass AND contype='f'`,
          [`${s}.shorts_publication_jobs`, `${s}.shorts_content`],
        );
        if (keys.length !== 1)
          throw new Error('Unexpected Shorts content foreign key');
        await db.query(`ALTER TABLE ${s}.shorts_publication_jobs DROP CONSTRAINT "${String(keys[0].conname).replaceAll('"', '""')}",
      ADD FOREIGN KEY(network,content_contract,id) REFERENCES ${s}.shorts_content(network,contract,id)`);
        await db.query(`CREATE FUNCTION ${s}.shorts_publication_content_scope() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $scope$
      DECLARE expected text;
      BEGIN
        SELECT coalesce(content_contract,contract) INTO expected FROM ${s}.shorts_publishing_contracts
          WHERE network=NEW.network AND contract=NEW.contract;
        IF expected IS NULL OR (NEW.content_contract IS NOT NULL AND NEW.content_contract<>expected)
          OR (TG_OP='UPDATE' AND (NEW.network,NEW.contract,NEW.id,NEW.content_contract)
            IS DISTINCT FROM (OLD.network,OLD.contract,OLD.id,OLD.content_contract)) THEN
          RAISE EXCEPTION 'Publication content identity changed' USING ERRCODE='SH409';
        END IF;
        NEW.content_contract=expected;
        RETURN NEW;
      END $scope$;
      REVOKE ALL ON FUNCTION ${s}.shorts_publication_content_scope() FROM PUBLIC;
      CREATE TRIGGER shorts_publication_content_scope BEFORE INSERT OR UPDATE OF network,contract,id,content_contract
        ON ${s}.shorts_publication_jobs FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_publication_content_scope()`);
        const [{ definition }] = await db.query(
          'SELECT pg_get_functiondef($1::regprocedure) AS definition',
          [`${s}.shorts_publication(text,jsonb)`],
        );
        const from = `${s}.shorts_content WHERE network=binding.network AND contract=binding.contract`;
        if (definition.split(from).length !== 4)
          throw new Error('Unexpected Shorts publication function');
        let sql = definition.replaceAll(
          from,
          `${s}.shorts_content WHERE network=binding.network AND contract=coalesce(binding.content_contract,binding.contract)`,
        );
        const guard =
          "OR payload->>'sourceHash' IS DISTINCT FROM binding.source_hash::text";
        if (sql.split(guard).length !== 2)
          throw new Error('Unexpected Shorts publication binding');
        sql = sql.replace(
          guard,
          `${guard}
      OR coalesce(payload->>'contentContract',payload->>'contract') IS DISTINCT FROM coalesce(binding.content_contract,binding.contract)`,
        );
        await db.query(sql);
      },
      async down(): Promise<void> {
        throw new Error(
          'Preserve contract-targeted journals and content bindings; use a forward migration',
        );
      },
    },

    /** Immutable content-count baseline for a legacy import; rewards stay on each source. */
    ShortsImportSnapshot1792368001000: {
      async up(db: QueryRunner): Promise<void> {
        await db.query(`ALTER TABLE shorts_receipt_scopes ADD COLUMN reward_contracts text[] NOT NULL DEFAULT '{}';
      CREATE TABLE shorts_import_snapshots (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      source varchar(100) NOT NULL, cutoff_hash varchar(100) NOT NULL,
      cutoff_height bigint NOT NULL CHECK(cutoff_height>=0), digest char(64) NOT NULL,
      videos bigint NOT NULL CHECK(videos>=0), likes bigint NOT NULL CHECK(likes>=0),
      PRIMARY KEY(network,contract), FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract));
      CREATE TABLE shorts_import_videos (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      likes bigint NOT NULL CHECK(likes>=0), withdrawn boolean NOT NULL,
      PRIMARY KEY(network,contract,id), FOREIGN KEY(network,contract) REFERENCES shorts_import_snapshots(network,contract))`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'DROP TABLE shorts_import_videos; DROP TABLE shorts_import_snapshots; ALTER TABLE shorts_receipt_scopes DROP COLUMN reward_contracts',
        );
      },
    },
  };
}
