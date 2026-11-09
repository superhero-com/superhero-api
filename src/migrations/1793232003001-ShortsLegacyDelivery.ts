import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

async function shortsLegacyDeliverySourcesBoundary(
  db: QueryRunner,
  s: string,
  reverse: boolean,
) {
  const patches = {
    shorts_delivery_job_guard: [
      [
        "NOT FOUND OR NOT original ? 'original' OR NEW.id=NEW.delivery_short_id",
        'NOT FOUND OR NEW.id=NEW.delivery_short_id',
      ],
      [
        "NEW.input->'bytes' IS DISTINCT FROM original->'bytes'",
        `NEW.input->'bytes' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->'bytes'`,
      ],
      [
        "NEW.input->'sha256' IS DISTINCT FROM original->'original'->'sha256'",
        `NEW.input->'sha256' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->'sha256'`,
      ],
      [
        `PERFORM ${s}.shorts_validate_original(original);`,
        `PERFORM ${s}.shorts_delivery_source(original);`,
      ],
    ],
    shorts_delivery_generation_guard: [
      [
        "NEW.body->'cid' IS DISTINCT FROM original->'cid' OR NEW.body->'bytes' IS DISTINCT FROM original->'bytes'\n          OR NEW.body->'original' IS DISTINCT FROM original->'original'",
        `NEW.body->'bytes' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->'bytes'
          OR NEW.body#>>'{original,sha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->>'sha256'
          OR (original ? 'original' AND (NEW.body->'cid' IS DISTINCT FROM original->'cid'
            OR NEW.body->'original' IS DISTINCT FROM original->'original'))`,
      ],
    ],
  };
  for (const [name, edits] of Object.entries(patches)) {
    const [{ definition }] = await db.query(
      'SELECT pg_get_functiondef($1::regprocedure) AS definition',
      [`${s}.${name}()`],
    );
    let sql = definition;
    for (const pair of reverse ? [...edits].reverse() : edits) {
      const [from, to] = reverse ? [pair[1], pair[0]] : pair;
      if (sql.split(from).length !== 2)
        throw new Error('Unexpected legacy delivery source predecessor');
      sql = sql.replace(from, to);
    }
    await db.query(sql);
  }
}

async function shortsLegacyDeliveryPackagesConstraint(
  db: QueryRunner,
  legacy: boolean,
) {
  await db.query(`ALTER TABLE shorts_delivery_packages DROP CONSTRAINT shorts_delivery_packages_prepared_check,
      ADD CONSTRAINT shorts_delivery_packages_prepared_check CHECK(
        jsonb_typeof(prepared)='object' AND prepared ?& ARRAY['cid','playlist','files']
        AND octet_length(prepared::text)<=147456 AND jsonb_typeof(prepared->'cid')='string'
        AND jsonb_typeof(prepared->'playlist')='string' AND jsonb_typeof(prepared->'files')='array'
        AND ((prepared->'version'='3'::jsonb AND prepared ? 'playlists'
          AND jsonb_typeof(prepared->'playlists')='object' AND prepared->>'cid' ~ '^b[a-z2-7]{20,118}$'
          AND jsonb_array_length(prepared->'files') BETWEEN 7 AND 256)
          ${
            legacy
              ? `OR (NOT prepared ? 'version' AND NOT prepared ? 'playlists'
            AND prepared->>'cid' ~ '^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,118})$'
            AND jsonb_array_length(prepared->'files') BETWEEN 3 AND 34)`
              : ''
          }) IS TRUE)`);
}

async function shortsLegacyDeliveryPackagesGuard(
  db: QueryRunner,
  reverse: boolean,
) {
  const [{ definition }] = await db.query(
    "SELECT pg_get_functiondef('shorts_delivery_package_guard()'::regprocedure) AS definition",
  );
  const before = `        IF NOT FOUND OR NOT content ? 'original' THEN
          RAISE EXCEPTION 'Original delivery source missing' USING ERRCODE='SH400';
        END IF;`;
  const after = `        IF NOT FOUND THEN
          RAISE EXCEPTION 'Original delivery source missing' USING ERRCODE='SH400';
        END IF;
        IF NOT content ? 'original' THEN
          IF content ? 'derivatives' OR jsonb_typeof(content->'files') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'Invalid legacy delivery source' USING ERRCODE='SH409';
          END IF;
          expected=jsonb_build_object('version',2,'id',NEW.short_id,'network',NEW.network,'contract',NEW.contract,
            'cid',content->'cid','generation',jsonb_build_object('job',NEW.short_id),
            'files',(SELECT jsonb_agg(jsonb_build_object('name',f->'name','bytes',f->'bytes','sha256',f->'sha256')
              ORDER BY f->>'name' COLLATE "C") FROM jsonb_array_elements(content->'files') f
              WHERE f->>'name' IN ('video.mp4','poster.jpg','captions.vtt')));
          IF jsonb_typeof(content->'cid') IS DISTINCT FROM 'string'
            OR content->>'cid' !~ '^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,118})$'
            OR jsonb_typeof(expected->'files') IS DISTINCT FROM 'array'
            OR jsonb_array_length(expected->'files') NOT BETWEEN 1 AND 3
            OR (SELECT count(*) FROM jsonb_array_elements(expected->'files') f WHERE f->>'name'='video.mp4')<>1
            OR (SELECT count(DISTINCT f->>'name') FROM jsonb_array_elements(expected->'files') f)<>jsonb_array_length(expected->'files')
            OR EXISTS(SELECT FROM jsonb_array_elements(expected->'files') f WHERE
              jsonb_typeof(f->'bytes') IS DISTINCT FROM 'number' OR coalesce(f->>'bytes','') !~ '^[1-9][0-9]{0,8}$'
              OR (f->>'bytes')::numeric>100000000 OR coalesce(f->>'sha256','') !~ '^[a-f0-9]{64}$') THEN
            RAISE EXCEPTION 'Invalid legacy delivery source' USING ERRCODE='SH409';
          END IF;
          IF NEW.source_identity::jsonb IS DISTINCT FROM expected
            OR NEW.source_key IS DISTINCT FROM (SELECT encode(sha256(convert_to(
              E'hls-v2\\n'||NEW.short_id||E'\\n'||(content->>'cid')||E'\\n'||(f->>'sha256')||E'\\n'||(f->>'bytes'),'UTF8')),'hex')
              FROM jsonb_array_elements(expected->'files') f WHERE f->>'name'='video.mp4')
            OR NEW.prepared ? 'version' OR NEW.prepared->>'cid' IS NOT DISTINCT FROM content->>'cid' THEN
            RAISE EXCEPTION 'Legacy acknowledgement differs from canonical delivery' USING ERRCODE='SH409';
          END IF;
          NEW.acknowledged_at=clock_timestamp();
          RETURN NEW;
        END IF;
        IF NEW.prepared->'version' IS DISTINCT FROM '3'::jsonb THEN
          RAISE EXCEPTION 'Original delivery requires an adaptive package' USING ERRCODE='SH409';
        END IF;`;
  const from = reverse ? after : before,
    to = reverse ? before : after;
  if (definition.split(from).length !== 2)
    throw new Error('Unexpected legacy package predecessor');
  await db.query(definition.replace(from, () => to));
}

async function shortsLegacyDeliverySelectionGuards(
  db: QueryRunner,
  reverse: boolean,
) {
  const [{ schema }] = await db.query('SELECT current_schema() AS schema');
  const s = `"${String(schema).replaceAll('"', '""')}"`;
  const patches = {
    shorts_delivery_package_guard: [
      [
        "IF NOT content ? 'original' THEN",
        "IF NOT content ? 'original' AND NEW.source_identity::jsonb #>> '{generation,job}'=NEW.short_id THEN",
      ],
      [
        `IF NOT FOUND OR content->'cid' IS DISTINCT FROM canonical->'cid'
            OR content->'bytes' IS DISTINCT FROM canonical->'bytes'
            OR content->'original' IS DISTINCT FROM canonical->'original' THEN`,
        `IF NOT FOUND OR content->'bytes' IS DISTINCT FROM ${s}.shorts_delivery_source(canonical)->'bytes'
            OR content#>>'{original,sha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(canonical)->>'sha256'
            OR (canonical ? 'original' AND (content->'cid' IS DISTINCT FROM canonical->'cid'
              OR content->'original' IS DISTINCT FROM canonical->'original')) THEN`,
      ],
    ],
    shorts_delivery_selection_guard: [
      [
        "NOT FOUND OR NOT original ? 'original' OR original->>'publication'",
        "NOT FOUND OR original->>'publication'",
      ],
      [
        "original#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}'",
        `original#>>'{safety,sourceSha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->>'sha256'`,
      ],
      [
        `PERFORM ${s}.shorts_validate_original(original);`,
        `PERFORM ${s}.shorts_delivery_source(original);`,
      ],
      [
        "candidate#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}'",
        `candidate#>>'{safety,sourceSha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->>'sha256'`,
      ],
      [
        `candidate->'cid' IS DISTINCT FROM original->'cid' OR candidate->'bytes' IS DISTINCT FROM original->'bytes'
              OR candidate->'original' IS DISTINCT FROM original->'original'`,
        `candidate->'bytes' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->'bytes'
              OR candidate#>>'{original,sha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->>'sha256'
              OR (original ? 'original' AND (candidate->'cid' IS DISTINCT FROM original->'cid'
                OR candidate->'original' IS DISTINCT FROM original->'original'))`,
      ],
    ],
  };
  for (const [name, edits] of Object.entries(patches)) {
    const [{ definition }] = await db.query(
      'SELECT pg_get_functiondef($1::regprocedure) AS definition',
      [`${s}.${name}()`],
    );
    let sql = definition;
    for (const pair of reverse ? [...edits].reverse() : edits) {
      const [from, to] = reverse ? [pair[1], pair[0]] : pair;
      if (sql.split(from).length !== 2)
        throw new Error('Unexpected legacy selection predecessor');
      sql = sql.replace(from, () => to);
    }
    await db.query(sql);
  }
}

export class ShortsLegacyDelivery1793232003001 extends FeatureMigration {
  readonly changes = {
    /** Prepare from retained uploads without changing a legacy post or selecting new playback. */
    ShortsLegacyDeliverySources1793232003000: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await db.query(`CREATE FUNCTION ${s}.shorts_delivery_source(body jsonb) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $source$
      DECLARE input jsonb; manifest jsonb; maximum bigint;
      BEGIN
        IF body ? 'original' OR body ? 'derivatives' THEN
          PERFORM ${s}.shorts_validate_original(body);
          RETURN jsonb_build_object('bytes',body->'bytes','sha256',body#>'{original,sha256}');
        END IF;
        input=body#>'{privateMedia,source}'; manifest=input->'manifest';
        IF body#>'{privateMedia,version}' IS DISTINCT FROM '1'::jsonb
          OR jsonb_typeof(body#>'{privateMedia,fence}') IS DISTINCT FROM 'string'
          OR coalesce(body#>>'{privateMedia,fence}','') !~ '^[1-9][0-9]{0,18}$'
          OR (body#>>'{privateMedia,fence}')::numeric>9223372036854775807
          OR input ? 'processingProfile' OR jsonb_typeof(input->'bytes') IS DISTINCT FROM 'number'
          OR coalesce(input->>'bytes','') !~ '^[1-9][0-9]{0,7}$'
          OR coalesce(input->>'sha256','') !~ '^[a-f0-9]{64}$'
          OR body#>>'{safety,sourceSha256}' IS DISTINCT FROM input->>'sha256'
          OR jsonb_typeof(manifest) IS DISTINCT FROM 'object'
          OR manifest->>'key' IS DISTINCT FROM input->>'objectKey'
          OR coalesce(manifest->>'key','') !~ '^[a-zA-Z0-9_/-]+$' OR length(manifest->>'key')>512
          OR position('//' in manifest->>'key')>0
          OR coalesce(manifest->>'keyId','') !~ '^[a-zA-Z0-9_-]{1,32}$'
          OR coalesce(manifest->>'sha256','') !~ '^[a-f0-9]{64}$'
          OR right(manifest->>'key',length(manifest->>'keyId')+66) IS DISTINCT FROM '/'||(manifest->>'keyId')||'/'||(manifest->>'sha256')
          OR jsonb_typeof(manifest->'bytes') IS DISTINCT FROM 'number'
          OR coalesce(manifest->>'bytes','') !~ '^[1-9][0-9]{0,4}$' OR (manifest->>'bytes')::integer>98304 THEN
          RAISE EXCEPTION 'Verified retained original source is unavailable' USING ERRCODE='SH409';
        END IF;
        IF input ? 'acceptedMaxBytes' THEN
          IF jsonb_typeof(input->'acceptedMaxBytes') IS DISTINCT FROM 'number'
            OR coalesce(input->>'acceptedMaxBytes','') !~ '^[1-9][0-9]{0,7}$' THEN
            RAISE EXCEPTION 'Invalid retained source admission' USING ERRCODE='SH409';
          END IF;
          maximum=(input->>'acceptedMaxBytes')::bigint;
        ELSE maximum=41943040; END IF;
        IF maximum>41943040 OR (input->>'bytes')::bigint>maximum THEN
          RAISE EXCEPTION 'Retained source exceeds admission' USING ERRCODE='SH409';
        END IF;
        RETURN jsonb_build_object('bytes',input->'bytes','sha256',input->'sha256');
      END $source$;
      REVOKE ALL ON FUNCTION ${s}.shorts_delivery_source(jsonb) FROM PUBLIC`);
        await shortsLegacyDeliverySourcesBoundary(db, s, false);
      },
      async down(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await db.query(
          `LOCK TABLE ${s}.shorts_content,${s}.shorts_ingestion,${s}.shorts_delivery_generations IN ACCESS EXCLUSIVE MODE`,
        );
        const [{ used }] =
          await db.query(`SELECT EXISTS(SELECT FROM ${s}.shorts_ingestion j JOIN ${s}.shorts_content c
      ON c.network=j.network AND c.contract=j.contract AND c.id=j.delivery_short_id WHERE NOT c.body ? 'original') AS used`);
        if (used)
          throw new Error(
            'Preserve legacy delivery preparation history before rollback',
          );
        await shortsLegacyDeliverySourcesBoundary(db, s, true);
        await db.query(`DROP FUNCTION ${s}.shorts_delivery_source(jsonb)`);
      },
    },

    /** Retain the legacy HLS package before replacing playback; canonical rows stay immutable. */
    ShortsLegacyDeliveryPackages1793232004000: {
      async up(db: QueryRunner): Promise<void> {
        await shortsLegacyDeliveryPackagesConstraint(db, true);
        await shortsLegacyDeliveryPackagesGuard(db, false);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_delivery_packages IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          "SELECT EXISTS(SELECT FROM shorts_delivery_packages WHERE prepared->'version' IS DISTINCT FROM '3'::jsonb) AS used",
        );
        if (used)
          throw new Error(
            'Preserve acknowledged legacy delivery before rollback',
          );
        await shortsLegacyDeliveryPackagesGuard(db, true);
        await shortsLegacyDeliveryPackagesConstraint(db, false);
      },
    },

    /** Select source-bound legacy upgrades without rewriting canonical publication. */
    ShortsLegacyDeliverySelection1793232005000: {
      async up(db: QueryRunner): Promise<void> {
        await shortsLegacyDeliverySelectionGuards(db, false);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_content,shorts_delivery_packages,shorts_delivery_selections IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] =
          await db.query(`SELECT EXISTS(SELECT FROM shorts_delivery_packages p JOIN shorts_content c
      ON c.network=p.network AND c.contract=p.contract AND c.id=p.short_id
      WHERE NOT c.body ? 'original' AND p.generation_job_id<>p.short_id) AS used`);
        if (used)
          throw new Error(
            'Preserve acknowledged legacy upgrade history before rollback',
          );
        await shortsLegacyDeliverySelectionGuards(db, true);
      },
    },

    ShortsBackfillBatches1793232006000: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await db.query(`CREATE TABLE ${s}.shorts_backfill_batches (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id uuid NOT NULL,
      request jsonb NOT NULL CHECK(octet_length(request::text)<=16384),
      plan jsonb NOT NULL CHECK(octet_length(plan::text)<=32768),
      status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','cancelled')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_token uuid, lease_until timestamptz,
      PRIMARY KEY(network,contract,id), FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_runtime(network,contract),
      CHECK((lease_token IS NULL)=(lease_until IS NULL))
    );
    CREATE UNIQUE INDEX shorts_backfill_one_active ON ${s}.shorts_backfill_batches(network,contract) WHERE status='running';
    CREATE TABLE ${s}.shorts_backfill_items (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, batch_id uuid NOT NULL,
      ordinal smallint NOT NULL CHECK(ordinal BETWEEN 0 AND 9), short_id varchar(80) NOT NULL,
      job_id varchar(80) NOT NULL, operation_id uuid NOT NULL, plan jsonb NOT NULL,
      phase text NOT NULL DEFAULT 'planned' CHECK(phase IN ('planned','preparing','ready','activated','failed','cancelled')),
      failures smallint NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 3),
      source_key text CHECK(source_key ~ '^[a-f0-9]{64}$'), error_code varchar(40),
      PRIMARY KEY(network,contract,batch_id,ordinal), UNIQUE(network,contract,job_id), UNIQUE(operation_id),
      UNIQUE(network,contract,batch_id,short_id),
      FOREIGN KEY(network,contract,batch_id) REFERENCES ${s}.shorts_backfill_batches(network,contract,id),
      FOREIGN KEY(network,contract,short_id) REFERENCES ${s}.shorts_content(network,contract,id)
    );
    REVOKE ALL ON ${s}.shorts_backfill_batches,${s}.shorts_backfill_items FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_backfill_identity_guard() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $guard$
    BEGIN
      IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Backfill history is retained' USING ERRCODE='SH409'; END IF;
      IF TG_TABLE_NAME='shorts_backfill_batches' THEN
        IF ROW(NEW.network,NEW.contract,NEW.id,NEW.request,NEW.plan,NEW.created_at) IS DISTINCT FROM
          ROW(OLD.network,OLD.contract,OLD.id,OLD.request,OLD.plan,OLD.created_at)
          OR (OLD.status<>'running' AND NEW.status<>OLD.status) THEN
          RAISE EXCEPTION 'Backfill identity is immutable' USING ERRCODE='SH409'; END IF;
      ELSE
        IF ROW(NEW.network,NEW.contract,NEW.batch_id,NEW.ordinal,NEW.short_id,NEW.job_id,NEW.operation_id,NEW.plan) IS DISTINCT FROM
          ROW(OLD.network,OLD.contract,OLD.batch_id,OLD.ordinal,OLD.short_id,OLD.job_id,OLD.operation_id,OLD.plan)
          OR (OLD.phase IN ('activated','failed','cancelled') AND NEW.phase<>OLD.phase)
          OR (OLD.source_key IS NOT NULL AND NEW.source_key IS DISTINCT FROM OLD.source_key) THEN
          RAISE EXCEPTION 'Backfill item identity is immutable' USING ERRCODE='SH409'; END IF;
      END IF;
      RETURN NEW;
    END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_backfill_identity_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_backfill_identity BEFORE UPDATE OR DELETE ON ${s}.shorts_backfill_batches
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_backfill_identity_guard();
    CREATE TRIGGER shorts_backfill_identity BEFORE UPDATE OR DELETE ON ${s}.shorts_backfill_items
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_backfill_identity_guard();
    CREATE TRIGGER shorts_backfill_no_truncate BEFORE TRUNCATE ON ${s}.shorts_backfill_batches
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_backfill_identity_guard();
    CREATE TRIGGER shorts_backfill_no_truncate BEFORE TRUNCATE ON ${s}.shorts_backfill_items
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_backfill_identity_guard();
    CREATE FUNCTION ${s}.shorts_backfill_work_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $work$
    DECLARE item ${s}.shorts_backfill_items%ROWTYPE; batch ${s}.shorts_backfill_batches%ROWTYPE;
    BEGIN
      IF TG_TABLE_NAME='shorts_ingestion' THEN
        SELECT * INTO item FROM ${s}.shorts_backfill_items WHERE network=NEW.network AND contract=NEW.contract AND job_id=NEW.id;
      ELSE
        SELECT * INTO item FROM ${s}.shorts_backfill_items WHERE operation_id=NEW.operation_id;
      END IF;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT * INTO batch FROM ${s}.shorts_backfill_batches WHERE network=item.network AND contract=item.contract AND id=item.batch_id FOR SHARE;
      IF batch.status<>'running' OR batch.lease_until IS NULL OR batch.lease_until<=clock_timestamp()
        OR batch.created_at<=clock_timestamp()-interval '24 hours'
        OR item.phase IN ('activated','failed','cancelled') OR item.network<>NEW.network OR item.contract<>NEW.contract
        OR EXISTS(SELECT FROM ${s}.shorts_retention_holds WHERE network=item.network AND contract=item.contract
          AND resource_id=item.short_id AND released_at IS NULL) THEN
        RAISE EXCEPTION 'Backfill work is no longer authorized' USING ERRCODE='SH409'; END IF;
      IF TG_TABLE_NAME='shorts_ingestion' THEN
        IF NEW.delivery_short_id IS DISTINCT FROM item.short_id THEN RAISE EXCEPTION 'Backfill target changed' USING ERRCODE='SH409'; END IF;
      ELSE
        IF item.phase<>'ready' OR NEW.short_id<>item.short_id OR NEW.kind<>'activate'
          OR NEW.source_key IS DISTINCT FROM item.source_key
          OR NOT EXISTS(SELECT FROM ${s}.shorts_delivery_packages p WHERE p.network=item.network AND p.contract=item.contract
            AND p.short_id=item.short_id AND p.source_key=NEW.source_key AND p.generation_job_id=item.job_id)
          OR NEW.from_source_key IS DISTINCT FROM item.plan#>>'{expected,sourceKey}'
          OR NEW.revision::bigint<>(item.plan#>>'{expected,revision}')::bigint+1 THEN
          RAISE EXCEPTION 'Backfill selection changed' USING ERRCODE='SH409'; END IF;
      END IF;
      RETURN NEW;
    END $work$;
    REVOKE ALL ON FUNCTION ${s}.shorts_backfill_work_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_backfill_work BEFORE INSERT ON ${s}.shorts_ingestion FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_backfill_work_guard();
    CREATE TRIGGER shorts_backfill_work BEFORE INSERT ON ${s}.shorts_delivery_selections FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_backfill_work_guard()`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_backfill_batches,shorts_backfill_items IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_backfill_batches) AS used',
        );
        if (used) throw new Error('Preserve backfill history before rollback');
        await db.query(`DROP TRIGGER shorts_backfill_work ON shorts_ingestion;
      DROP TRIGGER shorts_backfill_work ON shorts_delivery_selections;
      DROP FUNCTION shorts_backfill_work_guard();
      DROP TABLE shorts_backfill_items,shorts_backfill_batches;
      DROP FUNCTION shorts_backfill_identity_guard()`);
      },
    },
  };
}
