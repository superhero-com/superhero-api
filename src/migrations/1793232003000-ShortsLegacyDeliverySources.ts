import { MigrationInterface, QueryRunner } from 'typeorm';

/** Prepare from retained uploads without changing a legacy post or selecting new playback. */
export class ShortsLegacyDeliverySources1793232003000 implements MigrationInterface {
  private async boundary(db: QueryRunner, s: string, reverse: boolean) {
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
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
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
    await this.boundary(db, s, false);
  }
  async down(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
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
    await this.boundary(db, s, true);
    await db.query(`DROP FUNCTION ${s}.shorts_delivery_source(jsonb)`);
  }
}
