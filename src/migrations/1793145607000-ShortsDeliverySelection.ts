import { MigrationInterface, QueryRunner } from 'typeorm';

/** Append-only selection history; the canonical post is never rewritten. */
export class ShortsDeliverySelection1793145607000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
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
  }
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
  }
}
