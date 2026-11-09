import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

async function shortsOriginalContentBoundary(
  runner: QueryRunner,
  reverse: boolean,
) {
  const [{ schema }] = await runner.query('SELECT current_schema() AS schema');
  const s = `"${String(schema).replaceAll('"', '""')}"`;
  const changes: [string, string][] = [
    [
      `IF action='verify' THEN RETURN '{"capacityDeferVersion":1}'::jsonb; END IF;`,
      `IF action='verify' THEN RETURN '{"capacityDeferVersion":1,"originalContentVersion":1}'::jsonb; END IF;`,
    ],
    [
      'AND attempts<3 AND ((status=',
      `AND (input->>'processingProfile' IS NULL OR (input->>'processingProfile'='original-h264-v1' AND payload->'mediaProtocol'='2'::jsonb))
            AND attempts<3 AND ((status=`,
    ],
    [
      "output=payload->'record';",
      `output=payload->'record';
      IF job.input ? 'processingProfile' THEN
        IF job.input->>'processingProfile' IS DISTINCT FROM 'original-h264-v1'
          OR NOT (output ? 'original') OR NOT (output ? 'derivatives')
          OR output->'bytes' IS DISTINCT FROM job.input->'bytes'
          OR output->'derivatives'->'generation'->>'job' IS DISTINCT FROM job.id
          OR output->'derivatives'->'generation'->>'fence' IS DISTINCT FROM job.fence::text
          OR output->'original'->'sha256' IS DISTINCT FROM job.input->'sha256' THEN
          RAISE EXCEPTION 'Prepared original differs from accepted upload' USING ERRCODE='SH400';
        END IF;
        PERFORM ${s}.shorts_validate_original(output);
      ELSIF output ? 'original' OR output ? 'derivatives' THEN
        RAISE EXCEPTION 'Legacy job cannot change content format' USING ERRCODE='SH400';
      END IF;`,
    ],
    [
      "(output->>'bytes')::bigint NOT BETWEEN 1 AND 67108864",
      "(output->>'bytes')::numeric NOT BETWEEN 1 AND (CASE WHEN output ? 'original' THEN 100000000 ELSE 67108864 END)",
    ],
    [
      "IF jsonb_array_length(output->'files') NOT BETWEEN 3 AND 4 THEN",
      "IF NOT (output ? 'original') AND jsonb_array_length(output->'files') NOT BETWEEN 3 AND 4 THEN",
    ],
    [
      "file->>'name' NOT IN ('video.mp4','poster.jpg','manifest.json','captions.vtt')",
      "(NOT (output ? 'original') AND file->>'name' NOT IN ('video.mp4','poster.jpg','manifest.json','captions.vtt'))",
    ],
    [
      "(file->>'bytes')::bigint NOT BETWEEN 1 AND 67108864",
      "(file->>'bytes')::numeric NOT BETWEEN 1 AND (CASE WHEN output ? 'original' THEN 100000000 ELSE 67108864 END)",
    ],
    [
      "file_total<>(output->>'bytes')::bigint",
      "(NOT (output ? 'original') AND file_total<>(output->>'bytes')::bigint)",
    ],
    [
      `INSERT INTO ${s}.shorts_content(network,contract,id,creator,created_at,body)`,
      `IF output ? 'original' THEN
        body=body||jsonb_build_object('original',output->'original','derivatives',output->'derivatives');
      END IF;
      INSERT INTO ${s}.shorts_content(network,contract,id,creator,created_at,body)`,
    ],
  ];
  const [{ definition }] = await runner.query(
    'SELECT pg_get_functiondef($1::regprocedure) AS definition',
    [`${s}.shorts_media_worker(text,jsonb)`],
  );
  let sql = String(definition);
  for (const pair of changes) {
    const [from, to] = reverse ? [pair[1], pair[0]] : pair;
    if (sql.split(from).length !== 2)
      throw new Error(
        'Unexpected Shorts original-content migration predecessor',
      );
    sql = sql.replace(from, to);
  }
  await runner.query(sql);
}

async function shortsDeliveryGenerationsBoundary(
  db: QueryRunner,
  reverse: boolean,
) {
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

async function shortsGenerationDeliveryPackagesGuard(
  db: QueryRunner,
  reverse: boolean,
) {
  const [{ schema }] = await db.query('SELECT current_schema() AS schema');
  const s = `"${String(schema).replaceAll('"', '""')}"`;
  const [{ definition }] = await db.query(
    "SELECT pg_get_functiondef('shorts_delivery_package_guard()'::regprocedure) AS definition",
  );
  const initial =
    '        PERFORM ' + s + '.shorts_validate_original(content);';
  const replacement = `        generation_job=NEW.source_identity::jsonb #>> '{generation,job}';
        IF generation_job IS DISTINCT FROM NEW.short_id THEN
          canonical=content;
          SELECT body INTO content FROM ${s}.shorts_delivery_generations
            WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id AND job_id=generation_job FOR SHARE;
          IF NOT FOUND OR content->'cid' IS DISTINCT FROM canonical->'cid'
            OR content->'bytes' IS DISTINCT FROM canonical->'bytes'
            OR content->'original' IS DISTINCT FROM canonical->'original' THEN
            RAISE EXCEPTION 'Accepted delivery generation missing or original changed' USING ERRCODE='SH409';
          END IF;
        END IF;
${initial}`;
  const edits = [
    [
      'DECLARE content jsonb; expected jsonb;',
      'DECLARE content jsonb; expected jsonb; canonical jsonb; generation_job text;',
    ],
    [initial, replacement],
    [
      'Delivery acknowledgement differs from original generation',
      'Delivery acknowledgement differs from accepted generation',
    ],
  ];
  let next = definition;
  for (const [before, after] of edits) {
    const from = reverse ? after : before,
      to = reverse ? before : after;
    if (next.split(from).length !== 2)
      throw new Error('Unexpected delivery acknowledgement guard');
    next = next.replace(from, to);
  }
  await db.query(next);
}

async function shortsDeliveryStagingBoundary(
  db: QueryRunner,
  reverse: boolean,
) {
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

export class ShortsAdaptiveDelivery1793145600001 extends FeatureMigration {
  readonly changes = {
    /** Versioned original-file identity; legacy directory records keep their existing meaning. */
    ShortsOriginalContent1793145600000: {
      async up(runner: QueryRunner): Promise<void> {
        const [{ schema }] = await runner.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await runner.query(`CREATE FUNCTION ${s}.shorts_validate_original(content jsonb) RETURNS void
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $original$
      DECLARE
        original jsonb=content->'original'; delivery jsonb=content->'derivatives';
        file jsonb; video jsonb; rate text[]; fps numeric; total numeric=0; asset_total numeric=0;
        names text[]=ARRAY[]::text[]; videos text[]=ARRAY[]::text[];
      BEGIN
        IF NOT (content ? 'original' OR content ? 'derivatives') THEN RETURN; END IF;
        IF jsonb_typeof(original) IS DISTINCT FROM 'object' OR jsonb_typeof(delivery) IS DISTINCT FROM 'object'
          OR original->'version' IS DISTINCT FROM '1'::jsonb OR original->>'sha256' IS NULL OR original->>'sha256' !~ '^[a-f0-9]{64}$'
          OR original->>'mediaType' IS NULL OR original->>'mediaType' NOT IN ('video/mp4','video/quicktime')
          OR original->>'importProfile' IS DISTINCT FROM 'unixfs-file-v1-262144'
          OR content->>'cid' IS NULL OR content->>'cid' !~ '^b[a-z2-7]{20,118}$'
          OR jsonb_typeof(content->'bytes') IS DISTINCT FROM 'number' OR (content->>'bytes')::numeric NOT BETWEEN 1 AND 100000000
          OR trunc((content->>'bytes')::numeric)<>(content->>'bytes')::numeric
          OR delivery->'version' IS DISTINCT FROM '1'::jsonb OR delivery->>'profile' IS DISTINCT FROM 'original-h264-v1'
          OR delivery->>'cid' IS NULL OR delivery->>'cid' !~ '^b[a-z2-7]{20,118}$'
          OR delivery->>'assetsCid' IS NULL OR delivery->>'assetsCid' !~ '^b[a-z2-7]{20,118}$'
          OR delivery->>'assetsCid'=delivery->>'cid' OR delivery->>'cid'=content->>'cid' OR delivery->>'assetsCid'=content->>'cid'
          OR delivery->>'fingerprint' IS NULL OR delivery->>'fingerprint' !~ '^[a-f0-9]{64}$'
          OR jsonb_typeof(delivery->'generation') IS DISTINCT FROM 'object'
          OR delivery->'generation'->>'job' IS DISTINCT FROM content->>'id'
          OR jsonb_typeof(delivery->'generation'->'fence') IS DISTINCT FROM 'string'
          OR delivery->'generation'->>'fence' IS NULL OR delivery->'generation'->>'fence' !~ '^[1-9][0-9]{0,18}$'
          OR jsonb_typeof(content->'files') IS DISTINCT FROM 'array' OR jsonb_typeof(delivery->'videos') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Invalid original identity' USING ERRCODE='SH400';
        END IF;
        IF (delivery->'generation'->>'fence')::numeric>9223372036854775807 THEN
          RAISE EXCEPTION 'Invalid original generation fence' USING ERRCODE='SH400';
        END IF;
        IF jsonb_array_length(content->'files') NOT BETWEEN 5 AND 11 OR jsonb_array_length(delivery->'videos') NOT BETWEEN 2 AND 5 THEN
          RAISE EXCEPTION 'Invalid original delivery package' USING ERRCODE='SH400';
        END IF;
        FOR file IN SELECT value FROM jsonb_array_elements(content->'files') LOOP
          IF file->>'name' IS NULL OR file->>'name' NOT IN ('video-1080.mp4','video-720.mp4','video-480.mp4','video-360.mp4','video-rescue.mp4',
              'audio-main.m4a','audio-rescue.m4a','video.mp4','poster.jpg','manifest.json','captions.vtt')
            OR file->>'name'=ANY(names) OR file->>'sha256' IS NULL OR file->>'sha256' !~ '^[a-f0-9]{64}$'
            OR jsonb_typeof(file->'bytes') IS DISTINCT FROM 'number' OR (file->>'bytes')::numeric NOT BETWEEN 1 AND 100000000
            OR trunc((file->>'bytes')::numeric)<>(file->>'bytes')::numeric THEN
            RAISE EXCEPTION 'Invalid original derivative' USING ERRCODE='SH400';
          END IF;
          names=array_append(names,file->>'name'); total=total+(file->>'bytes')::numeric;
          IF file->>'name' IN ('video.mp4','poster.jpg','manifest.json','captions.vtt') THEN
            asset_total=asset_total+(file->>'bytes')::numeric;
          END IF;
        END LOOP;
        IF total>201326592 OR asset_total>67108864 OR NOT names @> ARRAY['video.mp4','poster.jpg','manifest.json']
          OR ('audio-main.m4a'=ANY(names)) IS DISTINCT FROM ('audio-rescue.m4a'=ANY(names))
          OR ('captions.vtt'=ANY(names)) IS DISTINCT FROM coalesce(content->'captions'='true'::jsonb,false) THEN
          RAISE EXCEPTION 'Incomplete original derivatives' USING ERRCODE='SH400';
        END IF;
        FOR video IN SELECT value FROM jsonb_array_elements(delivery->'videos') LOOP
          IF video->>'name' IS NULL OR video->>'name' !~ '^video-(1080|720|480|360|rescue)\\.mp4$'
            OR NOT (video->>'name'=ANY(names)) OR video->>'name'=ANY(videos)
            OR jsonb_typeof(video->'width') IS DISTINCT FROM 'number' OR jsonb_typeof(video->'height') IS DISTINCT FROM 'number'
            OR (video->>'width')::numeric NOT BETWEEN 2 AND 1920 OR (video->>'height')::numeric NOT BETWEEN 2 AND 1920
            OR mod((video->>'width')::numeric,2)<>0 OR mod((video->>'height')::numeric,2)<>0
            OR (video->>'width')::numeric*(video->>'height')::numeric>2073600
            OR video->>'frameRate' IS NULL OR video->>'frameRate' !~ '^[0-9]{1,7}/[0-9]{1,7}$' THEN
            RAISE EXCEPTION 'Invalid original rendition' USING ERRCODE='SH400';
          END IF;
          rate=string_to_array(video->>'frameRate','/');
          IF rate[2]::numeric=0 THEN RAISE EXCEPTION 'Invalid frame rate' USING ERRCODE='SH400'; END IF;
          fps=rate[1]::numeric/rate[2]::numeric;
          IF fps NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Invalid frame rate' USING ERRCODE='SH400'; END IF;
          videos=array_append(videos,video->>'name');
        END LOOP;
        IF NOT ('video-rescue.mp4'=ANY(videos)) OR EXISTS(SELECT FROM unnest(names) name WHERE name LIKE 'video-%' AND NOT name=ANY(videos)) THEN
          RAISE EXCEPTION 'Incomplete original ladder' USING ERRCODE='SH400';
        END IF;
        IF content ? 'privateMedia' AND (content->'privateMedia'->'source'->>'processingProfile' IS DISTINCT FROM 'original-h264-v1'
          OR content->'privateMedia'->'fence' IS DISTINCT FROM delivery->'generation'->'fence'
          OR content->'privateMedia'->'source'->'bytes' IS DISTINCT FROM content->'bytes'
          OR content->'privateMedia'->'source'->'sha256' IS DISTINCT FROM original->'sha256') THEN
          RAISE EXCEPTION 'Original differs from accepted source' USING ERRCODE='SH400';
        END IF;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Invalid original value' USING ERRCODE='SH400';
      END $original$;
      REVOKE ALL ON FUNCTION ${s}.shorts_validate_original(jsonb) FROM PUBLIC`);
        await runner.query(`CREATE FUNCTION ${s}.shorts_original_identity_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $identity$
      BEGIN
        IF TG_OP='UPDATE' AND (OLD.body ? 'original' OR NEW.body ? 'original' OR OLD.body ? 'derivatives' OR NEW.body ? 'derivatives')
          AND jsonb_build_array(OLD.body->'original',OLD.body->'derivatives',OLD.body->'cid',OLD.body->'bytes',OLD.body->'files')
          IS DISTINCT FROM jsonb_build_array(NEW.body->'original',NEW.body->'derivatives',NEW.body->'cid',NEW.body->'bytes',NEW.body->'files') THEN
          RAISE EXCEPTION 'Original identity is immutable' USING ERRCODE='SH409';
        END IF;
        PERFORM ${s}.shorts_validate_original(NEW.body);
        RETURN NEW;
      END $identity$;
      REVOKE ALL ON FUNCTION ${s}.shorts_original_identity_guard() FROM PUBLIC;
      CREATE TRIGGER shorts_original_identity_guard BEFORE INSERT OR UPDATE OF body ON ${s}.shorts_content
        FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_original_identity_guard()`);
        await shortsOriginalContentBoundary(runner, false);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query(
          'LOCK TABLE shorts_content,shorts_ingestion IN EXCLUSIVE MODE',
        );
        const [{ active }] =
          await runner.query(`SELECT EXISTS(SELECT FROM shorts_content WHERE body ? 'original' OR body ? 'derivatives')
      OR EXISTS(SELECT FROM shorts_ingestion WHERE input ? 'processingProfile') AS active`);
        if (active)
          throw new Error(
            'Original-file Shorts must be retained with their schema; rollback is unsafe',
          );
        await shortsOriginalContentBoundary(runner, true);
        await runner.query(`DROP TRIGGER shorts_original_identity_guard ON shorts_content;
      DROP FUNCTION shorts_original_identity_guard(); DROP FUNCTION shorts_validate_original(jsonb)`);
      },
    },

    ShortsAdaptiveInventory1793145601000: {
      async up(db: QueryRunner): Promise<void> {
        await db.query(`
      ALTER TABLE shorts_hls_inventory_runs ADD COLUMN reference_version smallint NOT NULL DEFAULT 1
        CHECK(reference_version IN (1,2,3,4,5));
      ALTER TABLE shorts_hls_inventory_roots ADD COLUMN pins jsonb NOT NULL DEFAULT '[]'
        CHECK(jsonb_typeof(pins)='array' AND jsonb_array_length(pins)<=64);
      CREATE INDEX shorts_hls_inventory_root_pins ON shorts_hls_inventory_roots USING gin(pins jsonb_path_ops);
      ALTER TABLE shorts_hls_inventory_entries ADD COLUMN version smallint NOT NULL DEFAULT 2 CHECK(version IN (2,3));
      ALTER TABLE shorts_hls_inventory_entries DROP CONSTRAINT shorts_hls_inventory_entries_bytes_check;
      ALTER TABLE shorts_hls_inventory_entries DROP CONSTRAINT shorts_hls_inventory_entries_files_check;
      ALTER TABLE shorts_hls_inventory_entries ADD CONSTRAINT shorts_hls_inventory_entries_bytes_check
        CHECK(bytes BETWEEN 1 AND CASE WHEN version=3 THEN 201326592 ELSE 100000000 END);
      ALTER TABLE shorts_hls_inventory_entries ADD CONSTRAINT shorts_hls_inventory_entries_files_check
        CHECK(jsonb_typeof(files)='array' AND jsonb_array_length(files) BETWEEN 3 AND CASE WHEN version=3 THEN 256 ELSE 34 END);
    `);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_hls_inventory_runs,shorts_hls_inventory_roots,shorts_hls_inventory_entries IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_hls_inventory_runs WHERE reference_version>=2)
        OR EXISTS(SELECT 1 FROM shorts_hls_inventory_roots WHERE pins<>'[]'::jsonb)
        OR EXISTS(SELECT 1 FROM shorts_hls_inventory_entries WHERE version=3) THEN
        RAISE EXCEPTION 'Preserve adaptive inventory history before rollback';
      END IF;
      ALTER TABLE shorts_hls_inventory_entries DROP CONSTRAINT shorts_hls_inventory_entries_bytes_check;
      ALTER TABLE shorts_hls_inventory_entries DROP CONSTRAINT shorts_hls_inventory_entries_files_check;
      ALTER TABLE shorts_hls_inventory_entries ADD CONSTRAINT shorts_hls_inventory_entries_bytes_check CHECK(bytes BETWEEN 1 AND 100000000);
      ALTER TABLE shorts_hls_inventory_entries ADD CONSTRAINT shorts_hls_inventory_entries_files_check
        CHECK(jsonb_typeof(files)='array' AND jsonb_array_length(files) BETWEEN 3 AND 34);
      ALTER TABLE shorts_hls_inventory_entries DROP COLUMN version;
      ALTER TABLE shorts_hls_inventory_roots DROP COLUMN pins;
      ALTER TABLE shorts_hls_inventory_runs DROP COLUMN reference_version;
    END $rollback$`);
      },
    },

    /** Durable acknowledgements for the initial, immutable original-media generation. */
    ShortsDeliveryPackages1793145602000: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await db.query(`CREATE TABLE ${s}.shorts_delivery_packages (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, short_id varchar(80) NOT NULL,
      source_key char(64) NOT NULL CHECK(source_key ~ '^[a-f0-9]{64}$'),
      source_identity text NOT NULL CHECK(octet_length(source_identity)<=16384),
      prepared jsonb NOT NULL CHECK(jsonb_typeof(prepared)='object' AND prepared ?& ARRAY['version','cid','playlist','playlists','files'] AND octet_length(prepared::text)<=147456
        AND prepared->'version'='3'::jsonb AND jsonb_typeof(prepared->'cid')='string' AND prepared->>'cid' ~ '^b[a-z2-7]{20,118}$'
        AND jsonb_typeof(prepared->'playlist')='string' AND jsonb_typeof(prepared->'playlists')='object'
        AND jsonb_typeof(prepared->'files')='array' AND jsonb_array_length(prepared->'files') BETWEEN 7 AND 256),
      acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,short_id,source_key),
      UNIQUE(network,contract,short_id),
      FOREIGN KEY(network,contract,short_id) REFERENCES ${s}.shorts_content(network,contract,id)
    );
    CREATE INDEX shorts_delivery_package_cid ON ${s}.shorts_delivery_packages((prepared->>'cid'));
    REVOKE ALL ON ${s}.shorts_delivery_packages FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_delivery_package_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      DECLARE content jsonb; expected jsonb;
      BEGIN
        IF TG_OP<>'INSERT' THEN
          RAISE EXCEPTION 'Acknowledged delivery packages are immutable' USING ERRCODE='SH409';
        END IF;
        SELECT body INTO content FROM ${s}.shorts_content
          WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.short_id FOR SHARE;
        IF NOT FOUND OR NOT content ? 'original' THEN
          RAISE EXCEPTION 'Original delivery source missing' USING ERRCODE='SH400';
        END IF;
        PERFORM ${s}.shorts_validate_original(content);
        expected=jsonb_build_object('id',NEW.short_id,'network',NEW.network,'contract',NEW.contract,
          'cid',content->'cid','bytes',content->'bytes','sha256',content->'original'->'sha256',
          'cidVersion',content->'original'->'importProfile','delivery',content->'derivatives'->'cid',
          'assets',content->'derivatives'->'assetsCid','profile',content->'derivatives'->'profile',
          'fingerprint',content->'derivatives'->'fingerprint','generation',content->'derivatives'->'generation',
          'videos',(SELECT jsonb_agg(jsonb_build_object('name',v->'name','width',v->'width','height',v->'height','frameRate',v->'frameRate')
            ORDER BY v->>'name' COLLATE "C") FROM jsonb_array_elements(content->'derivatives'->'videos') v),
          'files',(SELECT jsonb_agg(jsonb_build_object('name',f->'name','bytes',f->'bytes','sha256',f->'sha256')
            ORDER BY f->>'name' COLLATE "C") FROM jsonb_array_elements(content->'files') f));
        IF NEW.source_identity::jsonb IS DISTINCT FROM expected
          OR NEW.source_key<>encode(sha256(convert_to(E'hls-v3\\n'||NEW.source_identity,'UTF8')),'hex')
          OR NEW.prepared->>'cid' IN (content->>'cid',content->'derivatives'->>'cid',content->'derivatives'->>'assetsCid') THEN
          RAISE EXCEPTION 'Delivery acknowledgement differs from original generation' USING ERRCODE='SH409';
        END IF;
        NEW.acknowledged_at=clock_timestamp();
        RETURN NEW;
      END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_delivery_package_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_delivery_package_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_delivery_packages
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_delivery_package_guard();
    CREATE TRIGGER shorts_delivery_package_truncate BEFORE TRUNCATE ON ${s}.shorts_delivery_packages
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_delivery_package_guard()`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_delivery_packages IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_delivery_packages) AS used',
        );
        if (used)
          throw new Error(
            'Preserve acknowledged delivery packages before rollback',
          );
        await db.query(
          'DROP TABLE shorts_delivery_packages; DROP FUNCTION shorts_delivery_package_guard()',
        );
      },
    },

    /** Reuse fenced media execution without creating another post for a replacement encode. */
    ShortsDeliveryGenerations1793145603000: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
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
        await shortsDeliveryGenerationsBoundary(db, false);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_ingestion,shorts_delivery_generations IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_ingestion WHERE delivery_short_id IS NOT NULL) OR EXISTS(SELECT FROM shorts_delivery_generations) AS used',
        );
        if (used)
          throw new Error(
            'Preserve delivery generation history before rollback',
          );
        await shortsDeliveryGenerationsBoundary(db, true);
        await db.query(`DROP TABLE shorts_delivery_generations;
      DROP FUNCTION shorts_delivery_generation_guard();
      DROP TRIGGER shorts_delivery_job_guard ON shorts_ingestion;
      DROP FUNCTION shorts_delivery_job_guard();
      ALTER TABLE shorts_ingestion DROP COLUMN delivery_short_id`);
      },
    },

    /** File-backed renditions may exceed the legacy in-memory object ceiling. */
    ShortsFileStorageReferences1793145604000: {
      async up(db: QueryRunner): Promise<void> {
        await db.query(`ALTER TABLE shorts_storage_references
      DROP CONSTRAINT shorts_storage_references_bytes_check,
      ADD CONSTRAINT shorts_storage_references_file_bytes CHECK(bytes BETWEEN 1 AND 100000000)`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_storage_references IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_storage_references WHERE bytes>67108864) AS used',
        );
        if (used)
          throw new Error(
            'Preserve large file reference history before rollback',
          );
        await db.query(`ALTER TABLE shorts_storage_references
      DROP CONSTRAINT shorts_storage_references_file_bytes,
      ADD CONSTRAINT shorts_storage_references_bytes_check CHECK(bytes BETWEEN 1 AND 67108864)`);
      },
    },

    /** Acknowledging a replacement never selects it for public playback. */
    ShortsGenerationDeliveryPackages1793145605000: {
      async up(db: QueryRunner): Promise<void> {
        await db.query(`ALTER TABLE shorts_delivery_packages
      DROP CONSTRAINT shorts_delivery_packages_network_contract_short_id_key,
      ADD COLUMN generation_job_id varchar(80) GENERATED ALWAYS AS ((source_identity::jsonb #>> '{generation,job}')) STORED NOT NULL,
      ADD CONSTRAINT shorts_delivery_package_generation UNIQUE(network,contract,short_id,generation_job_id);
      CREATE INDEX shorts_delivery_package_generation_root ON shorts_delivery_packages(network,contract,generation_job_id)`);
        await shortsGenerationDeliveryPackagesGuard(db, false);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_delivery_packages IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_delivery_packages WHERE generation_job_id<>short_id) AS used',
        );
        if (used)
          throw new Error(
            'Preserve acknowledged generation history before rollback',
          );
        await shortsGenerationDeliveryPackagesGuard(db, true);
        await db.query(`ALTER TABLE shorts_delivery_packages DROP COLUMN generation_job_id,
      ADD CONSTRAINT shorts_delivery_packages_network_contract_short_id_key UNIQUE(network,contract,short_id)`);
      },
    },

    ShortsDeliveryStaging1793145606000: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
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
        await shortsDeliveryStagingBoundary(db, false);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_ingestion,shorts_delivery_staging IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_delivery_staging) AS used',
        );
        if (used)
          throw new Error('Preserve original staging history before rollback');
        await shortsDeliveryStagingBoundary(db, true);
        await db.query(
          'DROP TABLE shorts_delivery_staging; DROP FUNCTION shorts_delivery_staging_guard()',
        );
      },
    },

    /** Append-only selection history; the canonical post is never rewritten. */
    ShortsDeliverySelection1793145607000: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await db.query(`CREATE TABLE ${s}.shorts_delivery_selections (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, short_id varchar(80) NOT NULL,
      revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 1024), operation_id uuid NOT NULL,
      from_source_key char(64) NOT NULL, source_key char(64) NOT NULL,
      kind varchar(16) NOT NULL CHECK(kind IN ('activate','rollback')),
      selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK(from_source_key<>source_key), PRIMARY KEY(network,contract,short_id,revision),
      UNIQUE(network,contract,short_id,operation_id),
      FOREIGN KEY(network,contract,short_id,from_source_key) REFERENCES ${s}.shorts_delivery_packages(network,contract,short_id,source_key),
      FOREIGN KEY(network,contract,short_id,source_key) REFERENCES ${s}.shorts_delivery_packages(network,contract,short_id,source_key)
    );
    CREATE INDEX shorts_delivery_selected_version ON ${s}.shorts_delivery_selections(network,contract,short_id,source_key);
    CREATE INDEX shorts_delivery_retired_version ON ${s}.shorts_delivery_selections(network,contract,short_id,from_source_key,selected_at DESC);
    REVOKE ALL ON ${s}.shorts_delivery_selections FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_delivery_selection_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      DECLARE original jsonb; candidate jsonb; previous record; package record; key text; caption jsonb; other_caption jsonb;
      BEGIN
        IF TG_OP<>'INSERT' THEN
          RAISE EXCEPTION 'Delivery selection history is immutable' USING ERRCODE='SH409';
        END IF;
        IF NEW.kind='activate' AND NEW.revision>=1024 THEN
          RAISE EXCEPTION 'Final selection slot is reserved for rollback' USING ERRCODE='SH409';
        END IF;
        SELECT body INTO original FROM ${s}.shorts_content
          WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.short_id FOR UPDATE;
        IF NOT FOUND OR NOT original ? 'original' OR original->>'publication' IS DISTINCT FROM 'published'
          OR original->>'moderation' IS DISTINCT FROM 'approved'
          OR NOT COALESCE(original#>>'{safety,status}'='no_flags' OR
            (original#>>'{safety,status}'='review' AND original#>>'{safety,evidenceHash}'<>''
             AND original#>>'{safety,evidenceHash}'=original->>'visualReviewHash'),false)
          OR original#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}' THEN
          RAISE EXCEPTION 'Original delivery is not eligible' USING ERRCODE='SH409';
        END IF;
        PERFORM ${s}.shorts_validate_original(original);
        SELECT revision,source_key INTO previous FROM ${s}.shorts_delivery_selections
          WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id ORDER BY revision DESC LIMIT 1;
        IF FOUND THEN
          IF NEW.revision<>previous.revision+1 OR NEW.from_source_key<>previous.source_key THEN
            RAISE EXCEPTION 'Active delivery changed' USING ERRCODE='SH409';
          END IF;
        ELSE
          IF NEW.revision<>1 OR NOT EXISTS(SELECT FROM ${s}.shorts_delivery_packages
            WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id
              AND source_key=NEW.from_source_key AND generation_job_id=NEW.short_id) THEN
            RAISE EXCEPTION 'Initial delivery acknowledgement required' USING ERRCODE='SH409';
          END IF;
        END IF;
        IF NEW.kind='rollback' AND NOT EXISTS(SELECT FROM ${s}.shorts_delivery_selections
          WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id
            AND (source_key=NEW.source_key OR from_source_key=NEW.source_key)) THEN
          RAISE EXCEPTION 'Rollback target was never selected' USING ERRCODE='SH409';
        END IF;
        SELECT jsonb_build_array(f->'bytes',f->'sha256') INTO caption
          FROM jsonb_array_elements(original->'files') f WHERE f->>'name'='captions.vtt';
        FOREACH key IN ARRAY ARRAY[NEW.from_source_key,NEW.source_key] LOOP
          SELECT generation_job_id INTO package FROM ${s}.shorts_delivery_packages
            WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id AND source_key=key;
          IF NOT FOUND THEN RAISE EXCEPTION 'Acknowledged delivery required' USING ERRCODE='SH409'; END IF;
          IF package.generation_job_id<>NEW.short_id THEN
            SELECT body INTO candidate FROM ${s}.shorts_delivery_generations
              WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id AND job_id=package.generation_job_id;
            PERFORM ${s}.shorts_validate_original(candidate);
            SELECT jsonb_build_array(f->'bytes',f->'sha256') INTO other_caption
              FROM jsonb_array_elements(candidate->'files') f WHERE f->>'name'='captions.vtt';
            IF candidate IS NULL OR candidate->>'publication' IS NOT NULL
              OR candidate->>'moderation' IS DISTINCT FROM 'pending' OR candidate#>>'{safety,status}' IS DISTINCT FROM 'no_flags'
              OR candidate#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}'
              OR candidate->'cid' IS DISTINCT FROM original->'cid' OR candidate->'bytes' IS DISTINCT FROM original->'bytes'
              OR candidate->'original' IS DISTINCT FROM original->'original'
              OR jsonb_build_array(candidate->'creator',candidate->'title',candidate->'topic',COALESCE(candidate->>'description',''),
                COALESCE(NULLIF(candidate->>'language',''),'und'),COALESCE(candidate->'synthetic'='true'::jsonb,false),
                COALESCE(candidate->'sponsored'='true'::jsonb,false),COALESCE(candidate->'captions'='true'::jsonb,false),candidate->'duration')
                IS DISTINCT FROM jsonb_build_array(original->'creator',original->'title',original->'topic',COALESCE(original->>'description',''),
                COALESCE(NULLIF(original->>'language',''),'und'),COALESCE(original->'synthetic'='true'::jsonb,false),
                COALESCE(original->'sponsored'='true'::jsonb,false),COALESCE(original->'captions'='true'::jsonb,false),original->'duration')
              OR other_caption IS DISTINCT FROM caption THEN
              RAISE EXCEPTION 'Replacement delivery is not eligible' USING ERRCODE='SH409';
            END IF;
          END IF;
        END LOOP;
        NEW.selected_at=clock_timestamp();
        RETURN NEW;
      END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_delivery_selection_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_delivery_selection_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_delivery_selections
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_delivery_selection_guard();
    CREATE TRIGGER shorts_delivery_selection_truncate BEFORE TRUNCATE ON ${s}.shorts_delivery_selections
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_delivery_selection_guard()`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_delivery_selections IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_delivery_selections) AS used',
        );
        if (used)
          throw new Error('Preserve selected delivery history before rollback');
        await db.query(
          'DROP TABLE shorts_delivery_selections; DROP FUNCTION shorts_delivery_selection_guard()',
        );
      },
    },

    /** Retires a generation's processing inputs, never its original or delivery. */
    ShortsDeliveryInputRetirement1793145608000: {
      async up(db: QueryRunner): Promise<void> {
        const [{ schema }] = await db.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await db.query(`CREATE TABLE ${s}.shorts_delivery_input_retirements (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, short_id varchar(80) NOT NULL,
      source_key char(64) NOT NULL, operation_id uuid NOT NULL,
      input_cid varchar(120) NOT NULL, generation_job_id varchar(80) NOT NULL,
      retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,short_id,source_key),
      UNIQUE(network,contract,short_id,operation_id),
      FOREIGN KEY(network,contract,short_id,source_key) REFERENCES ${s}.shorts_delivery_packages(network,contract,short_id,source_key)
    );
    CREATE INDEX shorts_delivery_retired_input ON ${s}.shorts_delivery_input_retirements(input_cid);
    REVOKE ALL ON ${s}.shorts_delivery_input_retirements FROM PUBLIC;
    CREATE FUNCTION ${s}.shorts_delivery_input_retirement_guard() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      DECLARE original jsonb; candidate jsonb; package record; recent timestamptz; caption jsonb; other_caption jsonb;
      BEGIN
        IF TG_OP<>'INSERT' THEN
          RAISE EXCEPTION 'Input retirement history is immutable' USING ERRCODE='SH409';
        END IF;
        SELECT body INTO original FROM ${s}.shorts_content
          WHERE network=NEW.network AND contract=NEW.contract AND id=NEW.short_id FOR UPDATE;
        IF NOT FOUND OR NOT original ? 'original' OR original->>'publication' IS DISTINCT FROM 'published'
          OR original->>'moderation' IS DISTINCT FROM 'approved'
          OR NOT COALESCE(original#>>'{safety,status}'='no_flags' OR
            (original#>>'{safety,status}'='review' AND original#>>'{safety,evidenceHash}'<>''
             AND original#>>'{safety,evidenceHash}'=original->>'visualReviewHash'),false)
          OR original#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}' THEN
          RAISE EXCEPTION 'Original delivery is not eligible' USING ERRCODE='SH409';
        END IF;
        PERFORM ${s}.shorts_validate_original(original);
        SELECT * INTO package FROM ${s}.shorts_delivery_packages
          WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id AND source_key=NEW.source_key;
        IF NOT FOUND OR NEW.input_cid IS DISTINCT FROM package.source_identity::jsonb->>'delivery'
          OR NEW.generation_job_id IS DISTINCT FROM package.generation_job_id THEN
          RAISE EXCEPTION 'Retirement differs from acknowledged inputs' USING ERRCODE='SH409';
        END IF;
        candidate=original;
        IF package.generation_job_id<>NEW.short_id THEN
          SELECT body INTO candidate FROM ${s}.shorts_delivery_generations
            WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id AND job_id=package.generation_job_id;
          IF NOT FOUND OR candidate->>'moderation' IS DISTINCT FROM 'pending'
            OR candidate#>>'{safety,status}' IS DISTINCT FROM 'no_flags'
            OR candidate#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}'
            OR candidate->'cid' IS DISTINCT FROM original->'cid' OR candidate->'original' IS DISTINCT FROM original->'original'
            OR NOT EXISTS(SELECT FROM ${s}.shorts_delivery_selections
              WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id AND source_key=NEW.source_key) THEN
            RAISE EXCEPTION 'Only eligible selected generations can retire inputs' USING ERRCODE='SH409';
          END IF;
          SELECT jsonb_build_array(f->'bytes',f->'sha256') INTO caption
            FROM jsonb_array_elements(original->'files') f WHERE f->>'name'='captions.vtt';
          SELECT jsonb_build_array(f->'bytes',f->'sha256') INTO other_caption
            FROM jsonb_array_elements(candidate->'files') f WHERE f->>'name'='captions.vtt';
          IF jsonb_build_array(candidate->'creator',candidate->'title',candidate->'topic',COALESCE(candidate->>'description',''),
              COALESCE(NULLIF(candidate->>'language',''),'und'),COALESCE(candidate->'synthetic'='true'::jsonb,false),
              COALESCE(candidate->'sponsored'='true'::jsonb,false),COALESCE(candidate->'captions'='true'::jsonb,false),candidate->'duration')
            IS DISTINCT FROM jsonb_build_array(original->'creator',original->'title',original->'topic',COALESCE(original->>'description',''),
              COALESCE(NULLIF(original->>'language',''),'und'),COALESCE(original->'synthetic'='true'::jsonb,false),
              COALESCE(original->'sponsored'='true'::jsonb,false),COALESCE(original->'captions'='true'::jsonb,false),original->'duration')
            OR caption IS DISTINCT FROM other_caption THEN
            RAISE EXCEPTION 'Delivery metadata is no longer eligible' USING ERRCODE='SH409';
          END IF;
        END IF;
        IF COALESCE((original->>'reports')::integer,0)>0 OR COALESCE(jsonb_array_length(original->'reportDetails'),0)>0
          OR COALESCE((candidate->>'reports')::integer,0)>0 OR COALESCE(jsonb_array_length(candidate->'reportDetails'),0)>0
          OR original#>>'{appeal,status}'='pending' OR candidate#>>'{appeal,status}'='pending'
          OR EXISTS(SELECT FROM ${s}.shorts_retention_holds WHERE network=NEW.network AND contract=NEW.contract
            AND resource_id IN (NEW.short_id,NEW.generation_job_id) AND released_at IS NULL)
          OR EXISTS(SELECT FROM ${s}.shorts_ingestion WHERE network=NEW.network AND contract=NEW.contract
            AND id=NEW.generation_job_id AND status IN ('queued','processing')) THEN
          RAISE EXCEPTION 'Processing inputs are retained by policy' USING ERRCODE='SH409';
        END IF;
        SELECT max(selected_at) INTO recent FROM ${s}.shorts_delivery_selections
          WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id
            AND (source_key=NEW.source_key OR from_source_key=NEW.source_key);
        IF greatest(package.acknowledged_at,recent)>clock_timestamp()-interval '3720 seconds' THEN
          RAISE EXCEPTION 'Processing input retry and rollback window is active' USING ERRCODE='SH409';
        END IF;
        NEW.retired_at=clock_timestamp(); RETURN NEW;
      END $guard$;
    REVOKE ALL ON FUNCTION ${s}.shorts_delivery_input_retirement_guard() FROM PUBLIC;
    CREATE TRIGGER shorts_delivery_input_retirement_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_delivery_input_retirements
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_delivery_input_retirement_guard();
    CREATE TRIGGER shorts_delivery_input_retirement_truncate BEFORE TRUNCATE ON ${s}.shorts_delivery_input_retirements
      FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_delivery_input_retirement_guard()`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(
          'LOCK TABLE shorts_delivery_input_retirements IN ACCESS EXCLUSIVE MODE',
        );
        const [{ used }] = await db.query(
          'SELECT EXISTS(SELECT FROM shorts_delivery_input_retirements) AS used',
        );
        if (used)
          throw new Error('Preserve input retirement history before rollback');
        await db.query(`DROP TABLE shorts_delivery_input_retirements;
      DROP FUNCTION shorts_delivery_input_retirement_guard()`);
      },
    },
  };
}
