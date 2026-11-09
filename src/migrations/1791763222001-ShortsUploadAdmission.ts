import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

async function shortsWorkerBackpressureDefinitions(
  runner: QueryRunner,
  reverse: boolean,
) {
  const [{ schema }] = await runner.query('SELECT current_schema() AS schema');
  const s = `"${String(schema).replaceAll('"', '""')}"`;
  const defer = `IF action='defer' THEN
        IF payload - ARRAY['network','contract','sourceHash','id','fence','leaseToken'] <> '{}'::jsonb THEN
          RAISE EXCEPTION 'Invalid capacity deferral' USING ERRCODE='SH400';
        END IF;
        UPDATE ${s}.shorts_ingestion SET status='queued',attempts=greatest(attempts-1,0),
          lease_token=NULL,lease_principal=NULL,lease_until=NULL,
          error_code='capacity_wait',updated_at=clock_timestamp()
          WHERE network=binding.network AND contract=binding.contract AND id=job.id;
        RETURN 'true'::jsonb;
      END IF;
      `;
  const changes: [string, [string, string][]][] = [
    [
      'shorts_media_worker(text,jsonb)',
      [
        [
          "IF action='verify' THEN RETURN '{}'::jsonb; END IF;",
          "IF action='verify' THEN RETURN '{\"capacityDeferVersion\":1}'::jsonb; END IF;",
        ],
        [
          "AND attempts<3 AND (status='queued' OR (status='processing' AND lease_until<=clock_timestamp()))",
          "AND attempts<3 AND ((status='queued' AND (error_code IS DISTINCT FROM 'capacity_wait' OR updated_at<=clock_timestamp()-interval '5 seconds')) OR (status='processing' AND lease_until<=clock_timestamp()))",
        ],
        [
          "IF action NOT IN ('heartbeat','fail','complete') OR action IS NULL",
          "IF action NOT IN ('heartbeat','fail','complete','defer') OR action IS NULL",
        ],
        [
          "IF action IN ('heartbeat','fail') THEN RETURN 'false'::jsonb; END IF;",
          "IF action IN ('heartbeat','fail','defer') THEN RETURN 'false'::jsonb; END IF;",
        ],
        ["IF action='fail' THEN", `${defer}IF action='fail' THEN`],
      ],
    ],
    [
      'shorts_processing_capacity()',
      [
        [
          "IF NEW.status<>'processing' THEN RETURN NEW; END IF;",
          "IF NEW.status<>'processing' THEN RETURN NEW; END IF;\n        IF TG_OP='UPDATE' AND OLD.status='queued' AND OLD.error_code='capacity_wait' AND OLD.updated_at>clock_timestamp()-interval '5 seconds' THEN RETURN NULL; END IF;",
        ],
      ],
    ],
  ];
  // Preserve each function's identity, grants, definer and pinned search_path.
  // Refuse an unexpected predecessor instead of silently dropping a guard.
  const definitions: string[] = [];
  for (const [name, replacements] of changes) {
    const [{ definition }] = await runner.query(
      'SELECT pg_get_functiondef($1::regprocedure) AS definition',
      [`${s}.${name}`],
    );
    let sql = String(definition);
    for (const pair of replacements) {
      const [from, to] = reverse ? [pair[1], pair[0]] : pair;
      if (sql.split(from).length !== 2)
        throw new Error('Unexpected Shorts worker migration predecessor');
      sql = sql.replace(from, to);
    }
    definitions.push(sql);
  }
  for (const sql of definitions) await runner.query(sql);
}

async function shortsPublicationAdmissionDefinition(
  runner: QueryRunner,
  reverse: boolean,
) {
  const [{ schema }] = await runner.query('SELECT current_schema() AS schema');
  const s = `"${String(schema).replaceAll('"', '""')}"`;
  const changes: [string, string][] = [
    [
      "('verify','enqueue','status','claim','persist','authorize','renew','release','settle','reconcile')",
      "('verify','enqueue','status','capacity','claim','persist','authorize','renew','release','settle','reconcile')",
    ],
    [
      "jsonb_build_object('kind',principal.kind,'operator',binding.operator,'policy',account.policy)",
      "jsonb_build_object('kind',principal.kind,'operator',binding.operator,'policy',account.policy,'preparationCapacityVersion',1)",
    ],
    [
      "principal.kind='api' AND action NOT IN ('enqueue','status')",
      "principal.kind='api' AND action NOT IN ('enqueue','status','capacity')",
    ],
    [
      "IF job.intent IS DISTINCT FROM intent THEN RAISE EXCEPTION 'Immutable publication identity' USING ERRCODE='SH409'; END IF;",
      "IF job.intent IS DISTINCT FROM intent THEN RAISE EXCEPTION 'Immutable publication identity' USING ERRCODE='SH409'; END IF;\n          IF action='capacity' THEN RETURN '{\"ready\":false}'::jsonb; END IF;",
    ],
    [
      "IF account.paused THEN RAISE EXCEPTION 'Publication paused' USING ERRCODE='SH503'; END IF;",
      "IF account.paused THEN\n          IF action='capacity' THEN RETURN '{\"ready\":false}'::jsonb; END IF;\n          RAISE EXCEPTION 'Publication paused' USING ERRCODE='SH503';\n        END IF;",
    ],
    [
      "RAISE EXCEPTION 'Publication queue full' USING ERRCODE='SH503';",
      "IF action='capacity' THEN RETURN '{\"ready\":false}'::jsonb; END IF;\n          RAISE EXCEPTION 'Publication queue full' USING ERRCODE='SH503';",
    ],
    [
      `INSERT INTO ${s}.shorts_publication_jobs(network,contract,id,operator,creator,intent)`,
      `IF action='capacity' THEN RETURN '{"ready":true}'::jsonb; END IF;
        INSERT INTO ${s}.shorts_publication_jobs(network,contract,id,operator,creator,intent)`,
    ],
  ];
  const [{ definition }] = await runner.query(
    'SELECT pg_get_functiondef($1::regprocedure) AS definition',
    [`${s}.shorts_publication(text,jsonb)`],
  );
  let sql = String(definition);
  for (const pair of changes) {
    const [from, to] = reverse ? [pair[1], pair[0]] : pair;
    if (sql.split(from).length !== 2)
      throw new Error('Unexpected Shorts publication migration predecessor');
    sql = sql.replace(from, to);
  }
  // CREATE OR REPLACE preserves identity, definer, grants and fixed search_path.
  // Both directions leave every journal row, signed byte and reservation intact.
  await runner.query(sql);
}

export class ShortsUploadAdmission1791763222001 extends FeatureMigration {
  readonly steps = {
    /** Capacity waits preserve the source and retry budget under the existing worker authority. */
    ShortsWorkerBackpressure: {
      async up(runner: QueryRunner): Promise<void> {
        await shortsWorkerBackpressureDefinitions(runner, false);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('LOCK TABLE shorts_ingestion IN EXCLUSIVE MODE');
        const [{ waiting }] =
          await runner.query(`SELECT EXISTS(SELECT FROM shorts_ingestion
      WHERE status='processing' OR (status='queued' AND error_code='capacity_wait')) AS waiting`);
        if (waiting)
          throw new Error(
            'Drain processing and deferred Shorts jobs before rollback',
          );
        await shortsWorkerBackpressureDefinitions(runner, true);
      },
    },

    /** Read-only preparation admission within the existing scoped publisher boundary. */
    ShortsPublicationAdmission: {
      async up(runner: QueryRunner): Promise<void> {
        await shortsPublicationAdmissionDefinition(runner, false);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query(
          'LOCK TABLE shorts_publishing_accounts IN EXCLUSIVE MODE',
        );
        await shortsPublicationAdmissionDefinition(runner, true);
      },
    },

    /** Durable ingress reservations. Expiry, failure and withdrawal never refund storage. */
    ShortsUploadBudget: {
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
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_upload_budgets(network,contract)
    );
    INSERT INTO ${s}.shorts_upload_budgets(network,contract) SELECT network,contract FROM ${s}.shorts_runtime`);
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
      DECLARE existing ${s}.shorts_upload_reservations%ROWTYPE; charged_bytes bigint;
        budget ${s}.shorts_upload_budgets%ROWTYPE;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'Upload admission requires READ COMMITTED' USING ERRCODE='SH400';
        END IF;
        IF TG_TABLE_NAME='shorts_content' THEN
          charged_bytes=(NEW.body->>'bytes')::bigint;
        ELSE charged_bytes=(NEW.input->>'bytes')::bigint; END IF;
        IF charged_bytes IS NULL OR charged_bytes<1 THEN
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
          IF existing.creator<>NEW.creator OR existing.source_bytes<>charged_bytes THEN
            RAISE EXCEPTION 'Upload reservation identity differs' USING ERRCODE='SH409';
          END IF;
          RETURN NEW;
        END IF;
        IF budget.used_uploads>=budget.max_uploads OR charged_bytes>budget.max_source_bytes-budget.used_source_bytes THEN
          RAISE EXCEPTION 'Upload budget exhausted' USING ERRCODE='SH509';
        END IF;
        INSERT INTO ${s}.shorts_upload_reservations(network,contract,id,creator,source_bytes)
          VALUES(NEW.network,NEW.contract,NEW.id,NEW.creator,charged_bytes);
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
      },
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
      },
    },

    /** Preserve lifecycle retries while shared media transfer capacity is unavailable. */
    ShortsMediaAdmission: {
      async up(db: QueryRunner): Promise<void> {
        await db.query(`ALTER TABLE shorts_lifecycle_jobs DROP CONSTRAINT shorts_lifecycle_jobs_result_check,
      ADD CONSTRAINT shorts_lifecycle_jobs_result_check CHECK(result IN
        ('checked','publication_pending','retention_pending','reconciliation_required','failed','capacity_wait'))`);
      },
      async down(db: QueryRunner): Promise<void> {
        // The constraint refuses downgrade while capacity waits exist; no saved work is rewritten.
        await db.query(`ALTER TABLE shorts_lifecycle_jobs DROP CONSTRAINT shorts_lifecycle_jobs_result_check,
      ADD CONSTRAINT shorts_lifecycle_jobs_result_check CHECK(result IN
        ('checked','publication_pending','retention_pending','reconciliation_required','failed'))`);
      },
    },

    /** Content and chain updates share the existing scoped live-update channel. */
    ShortsContentUpdates: {
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
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query(
          'DROP TRIGGER shorts_content_updated ON shorts_content',
        );
        await runner.query('DROP FUNCTION shorts_content_updated()');
      },
    },

    /** Bounded, immutable per-part permissions; abandoned intents remain inventoried. */
    ShortsDirectUploads: {
      async up(db: QueryRunner): Promise<void> {
        await db.query(`ALTER TABLE shorts_upload_sessions ADD COLUMN direct_parts jsonb NOT NULL DEFAULT '{}'::jsonb
      CHECK(jsonb_typeof(direct_parts)='object' AND octet_length(direct_parts::text)<=65536)`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          `LOCK TABLE shorts_upload_sessions IN ACCESS EXCLUSIVE MODE`,
        );
        await db.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM shorts_upload_sessions WHERE direct_parts<>'{}'::jsonb)
      THEN RAISE EXCEPTION 'Preserve direct upload references before rollback'; END IF; END $$`);
        await db.query(
          'ALTER TABLE shorts_upload_sessions DROP COLUMN direct_parts',
        );
      },
    },
  };
}
