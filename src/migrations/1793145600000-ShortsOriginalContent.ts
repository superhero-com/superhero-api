import { MigrationInterface, QueryRunner } from 'typeorm';

/** Versioned original-file identity; legacy directory records keep their existing meaning. */
export class ShortsOriginalContent1793145600000 implements MigrationInterface {
  private async boundary(runner: QueryRunner, reverse: boolean) {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
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
    await this.boundary(runner, false);
  }

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
    await this.boundary(runner, true);
    await runner.query(`DROP TRIGGER shorts_original_identity_guard ON shorts_content;
      DROP FUNCTION shorts_original_identity_guard(); DROP FUNCTION shorts_validate_original(jsonb)`);
  }
}
