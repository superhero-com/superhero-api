import { MigrationInterface, QueryRunner } from 'typeorm';

/** Retires a generation's processing inputs, never its original or delivery. */
export class ShortsDeliveryInputRetirement1793145608000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
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
  }
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
  }
}
