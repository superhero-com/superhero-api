import { MigrationInterface, QueryRunner } from 'typeorm';

/** Retain the legacy HLS package before replacing playback; canonical rows stay immutable. */
export class ShortsLegacyDeliveryPackages1793232004000 implements MigrationInterface {
  private async constraint(db: QueryRunner, legacy: boolean) {
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
  private async guard(db: QueryRunner, reverse: boolean) {
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
  async up(db: QueryRunner): Promise<void> {
    await this.constraint(db, true);
    await this.guard(db, false);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_delivery_packages IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      "SELECT EXISTS(SELECT FROM shorts_delivery_packages WHERE prepared->'version' IS DISTINCT FROM '3'::jsonb) AS used",
    );
    if (used)
      throw new Error('Preserve acknowledged legacy delivery before rollback');
    await this.guard(db, true);
    await this.constraint(db, false);
  }
}
