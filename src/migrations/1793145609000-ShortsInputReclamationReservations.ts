import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable reference quiescence. This schema deliberately issues no delete permits. */
export class ShortsInputReclamationReservations1793145609000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE FUNCTION ${s}.shorts_cid_pin_identity(value text) RETURNS text
      LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $cid$
      DECLARE n numeric=0; digit integer; raw bytea=''::bytea; alphabet text='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        base32 text='abcdefghijklmnopqrstuvwxyz234567'; result text='b'; acc integer=0; bits integer=0; i integer;
      BEGIN
        -- CIDv0 and dag-pb CIDv1 share a Kubo pin. Normalize legacy v0 before
        -- locking/indexing so an alternate spelling cannot evade retention.
        IF value !~ '^Qm[1-9A-HJ-NP-Za-km-z]{44}$' THEN RETURN value; END IF;
        FOR i IN 1..length(value) LOOP n=n*58+strpos(alphabet,substr(value,i,1))-1; END LOOP;
        WHILE n>0 LOOP digit=mod(n,256)::integer;raw=decode(lpad(to_hex(digit),2,'0'),'hex')||raw;n=div(n,256);END LOOP;
        IF octet_length(raw)<>34 OR get_byte(raw,0)<>18 OR get_byte(raw,1)<>32 THEN RETURN value;END IF;
        raw=decode('0170','hex')||raw;
        FOR i IN 0..octet_length(raw)-1 LOOP
          acc=(acc<<8)|get_byte(raw,i);bits=bits+8;
          WHILE bits>=5 LOOP bits=bits-5;result=result||substr(base32,((acc>>bits)&31)+1,1);END LOOP;
          acc=acc&((1<<bits)-1);
        END LOOP;
        IF bits>0 THEN result=result||substr(base32,((acc<<(5-bits))&31)+1,1);END IF;
        RETURN result;
      END $cid$;
      CREATE INDEX shorts_content_pin_identity ON ${s}.shorts_content(${s}.shorts_cid_pin_identity(body->>'cid'));
      CREATE INDEX shorts_generation_pin_identity ON ${s}.shorts_delivery_generations(${s}.shorts_cid_pin_identity(body->>'cid'));
      CREATE INDEX shorts_content_input_cid ON ${s}.shorts_content((body->'derivatives'->>'cid'));
      CREATE INDEX shorts_content_assets_cid ON ${s}.shorts_content((body->'derivatives'->>'assetsCid'));
      CREATE INDEX shorts_generation_original_cid ON ${s}.shorts_delivery_generations((body->>'cid'));
      CREATE TABLE ${s}.shorts_input_reclamation_reservations (
        operation_id uuid PRIMARY KEY, input_cid varchar(120) NOT NULL CHECK(input_cid ~ '^b[a-z2-7]{20,118}$'),
        state varchar(16) NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','invalidated','released')),
        roots jsonb NOT NULL CHECK(jsonb_typeof(roots)='array' AND jsonb_array_length(roots) BETWEEN 1 AND 64 AND octet_length(roots::text)<=32768),
        reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), invalidated_at timestamptz, released_at timestamptz,
        CHECK((state='released')=(released_at IS NOT NULL)),
        CHECK(state<>'invalidated' OR invalidated_at IS NOT NULL)
      );
      CREATE UNIQUE INDEX shorts_input_reclamation_active ON ${s}.shorts_input_reclamation_reservations(input_cid) WHERE state<>'released';
      CREATE INDEX shorts_input_reclamation_history ON ${s}.shorts_input_reclamation_reservations(input_cid,reserved_at);
      REVOKE ALL ON ${s}.shorts_input_reclamation_reservations FROM PUBLIC;

      CREATE FUNCTION ${s}.shorts_input_reclamation_roots(target text) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $roots$
      DECLARE item record; original jsonb; package record; retirement record; result jsonb='[]'; recent timestamptz;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'Input reclamation requires READ COMMITTED' USING ERRCODE='SH400';
        END IF;
        IF EXISTS(SELECT FROM ${s}.shorts_content WHERE ${s}.shorts_cid_pin_identity(body->>'cid')=target OR body->'derivatives'->>'assetsCid'=target)
          OR EXISTS(SELECT FROM ${s}.shorts_delivery_generations WHERE ${s}.shorts_cid_pin_identity(body->>'cid')=target OR body->'derivatives'->>'assetsCid'=target)
          OR EXISTS(SELECT FROM ${s}.shorts_delivery_packages WHERE prepared->>'cid'=target) THEN
          RAISE EXCEPTION 'CID is retained by permanent or legacy media' USING ERRCODE='SH409';
        END IF;
        FOR item IN SELECT * FROM (
          SELECT network,contract,id AS short_id,id AS job_id,body FROM ${s}.shorts_content WHERE body->'derivatives'->>'cid'=target
          UNION ALL SELECT network,contract,short_id,job_id,body FROM ${s}.shorts_delivery_generations WHERE body->'derivatives'->>'cid'=target
        ) r ORDER BY network COLLATE "C",contract COLLATE "C",short_id COLLATE "C",job_id COLLATE "C" LIMIT 65 LOOP
          IF jsonb_array_length(result)>=64 THEN RAISE EXCEPTION 'Shared input reference limit exceeded' USING ERRCODE='SH509'; END IF;
          PERFORM ${s}.shorts_validate_original(item.body);
          SELECT body INTO original FROM ${s}.shorts_content WHERE network=item.network AND contract=item.contract AND id=item.short_id;
          IF NOT FOUND OR original->>'publication' IS DISTINCT FROM 'published' OR original->>'moderation' IS DISTINCT FROM 'approved'
            OR NOT COALESCE(original#>>'{safety,status}'='no_flags' OR
              (original#>>'{safety,status}'='review' AND original#>>'{safety,evidenceHash}'<>''
               AND original#>>'{safety,evidenceHash}'=original->>'visualReviewHash'),false)
            OR original#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}' THEN
            RAISE EXCEPTION 'Referenced original is not eligible' USING ERRCODE='SH409';
          END IF;
          SELECT * INTO package FROM ${s}.shorts_delivery_packages
            WHERE network=item.network AND contract=item.contract AND short_id=item.short_id AND generation_job_id=item.job_id;
          IF NOT FOUND OR package.source_identity::jsonb->>'delivery' IS DISTINCT FROM target THEN
            RAISE EXCEPTION 'Every input reference needs acknowledged delivery' USING ERRCODE='SH409';
          END IF;
          SELECT * INTO retirement FROM ${s}.shorts_delivery_input_retirements
            WHERE network=item.network AND contract=item.contract AND short_id=item.short_id AND source_key=package.source_key;
          IF NOT FOUND OR retirement.input_cid<>target OR retirement.generation_job_id<>item.job_id THEN
            RAISE EXCEPTION 'Every shared input reference must be retired' USING ERRCODE='SH409';
          END IF;
          IF item.job_id<>item.short_id AND (item.body->>'moderation' IS DISTINCT FROM 'pending'
            OR item.body#>>'{safety,status}' IS DISTINCT FROM 'no_flags'
            OR item.body#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}'
            OR item.body->'cid' IS DISTINCT FROM original->'cid' OR item.body->'original' IS DISTINCT FROM original->'original') THEN
            RAISE EXCEPTION 'Referenced generation is not eligible' USING ERRCODE='SH409';
          END IF;
          IF item.job_id<>item.short_id AND (
            jsonb_build_array(item.body->'creator',item.body->'title',item.body->'topic',COALESCE(item.body->>'description',''),
              COALESCE(NULLIF(item.body->>'language',''),'und'),COALESCE(item.body->'synthetic'='true'::jsonb,false),
              COALESCE(item.body->'sponsored'='true'::jsonb,false),COALESCE(item.body->'captions'='true'::jsonb,false),item.body->'duration')
              IS DISTINCT FROM jsonb_build_array(original->'creator',original->'title',original->'topic',COALESCE(original->>'description',''),
              COALESCE(NULLIF(original->>'language',''),'und'),COALESCE(original->'synthetic'='true'::jsonb,false),
              COALESCE(original->'sponsored'='true'::jsonb,false),COALESCE(original->'captions'='true'::jsonb,false),original->'duration')
            OR (SELECT jsonb_build_array(f->'bytes',f->'sha256') FROM jsonb_array_elements(item.body->'files') f WHERE f->>'name'='captions.vtt')
              IS DISTINCT FROM (SELECT jsonb_build_array(f->'bytes',f->'sha256') FROM jsonb_array_elements(original->'files') f WHERE f->>'name'='captions.vtt')) THEN
            RAISE EXCEPTION 'Retained generation metadata changed' USING ERRCODE='SH409';
          END IF;
          IF COALESCE((original->>'reports')::integer,0)>0 OR COALESCE(jsonb_array_length(original->'reportDetails'),0)>0
            OR COALESCE((item.body->>'reports')::integer,0)>0 OR COALESCE(jsonb_array_length(item.body->'reportDetails'),0)>0
            OR original#>>'{appeal,status}'='pending' OR item.body#>>'{appeal,status}'='pending'
            OR EXISTS(SELECT FROM ${s}.shorts_retention_holds WHERE network=item.network AND contract=item.contract
              AND resource_id IN (item.short_id,item.job_id) AND released_at IS NULL)
            OR EXISTS(SELECT FROM ${s}.shorts_ingestion WHERE network=item.network AND contract=item.contract
              AND (id=item.job_id OR delivery_short_id=item.short_id) AND status IN ('queued','processing')) THEN
            RAISE EXCEPTION 'Referenced inputs are retained by policy or active work' USING ERRCODE='SH409';
          END IF;
          SELECT max(selected_at) INTO recent FROM ${s}.shorts_delivery_selections
            WHERE network=item.network AND contract=item.contract AND short_id=item.short_id
              AND (source_key=package.source_key OR from_source_key=package.source_key);
          IF greatest(package.acknowledged_at,recent)>clock_timestamp()-interval '3720 seconds' THEN
            RAISE EXCEPTION 'Input retry and rollback window is active' USING ERRCODE='SH409';
          END IF;
          result=result||jsonb_build_array(jsonb_build_object('network',item.network,'contract',item.contract,
            'shortId',item.short_id,'jobId',item.job_id,'sourceKey',package.source_key));
        END LOOP;
        IF jsonb_array_length(result)=0 THEN RAISE EXCEPTION 'No retired input references' USING ERRCODE='SH409'; END IF;
        RETURN result;
      END $roots$;
      REVOKE ALL ON FUNCTION ${s}.shorts_input_reclamation_roots(text) FROM PUBLIC;

      CREATE FUNCTION ${s}.shorts_input_reclamation_reservation_guard() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $guard$
      BEGIN
        IF TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'Reclamation history is immutable' USING ERRCODE='SH409'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||NEW.input_cid,0));
        IF TG_OP='INSERT' THEN
          IF NEW.state<>'reserved' OR NEW.invalidated_at IS NOT NULL OR NEW.released_at IS NOT NULL THEN
            RAISE EXCEPTION 'Invalid reclamation reservation' USING ERRCODE='SH409';
          END IF;
          NEW.roots=${s}.shorts_input_reclamation_roots(NEW.input_cid);
          NEW.reserved_at=clock_timestamp(); RETURN NEW;
        END IF;
        IF ROW(NEW.operation_id,NEW.input_cid,NEW.roots,NEW.reserved_at) IS DISTINCT FROM ROW(OLD.operation_id,OLD.input_cid,OLD.roots,OLD.reserved_at)
          OR OLD.state='released' OR NEW.state NOT IN ('invalidated','released')
          OR NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at OR NEW.released_at IS DISTINCT FROM OLD.released_at THEN
          RAISE EXCEPTION 'Invalid reclamation reservation transition' USING ERRCODE='SH409';
        END IF;
        IF NEW.state='invalidated' THEN
          NEW.invalidated_at=COALESCE(OLD.invalidated_at,clock_timestamp());
        ELSE NEW.released_at=clock_timestamp(); END IF;
        RETURN NEW;
      END $guard$;
      REVOKE ALL ON FUNCTION ${s}.shorts_input_reclamation_reservation_guard() FROM PUBLIC;
      CREATE TRIGGER shorts_input_reclamation_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.shorts_input_reclamation_reservations
        FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_input_reclamation_reservation_guard();
      CREATE TRIGGER shorts_input_reclamation_truncate BEFORE TRUNCATE ON ${s}.shorts_input_reclamation_reservations
        FOR EACH STATEMENT EXECUTE FUNCTION ${s}.shorts_input_reclamation_reservation_guard();

      CREATE FUNCTION ${s}.shorts_cid_reference_guard() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $reference$
      DECLARE cids text[]; cid text;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'CID reference writes require READ COMMITTED' USING ERRCODE='SH400';
        END IF;
        IF TG_TABLE_NAME='shorts_delivery_packages' THEN
          cids=ARRAY[NEW.prepared->>'cid',NEW.source_identity::jsonb->>'cid',NEW.source_identity::jsonb->>'delivery',NEW.source_identity::jsonb->>'assets'];
        ELSIF TG_TABLE_NAME='shorts_delivery_selections' THEN
          SELECT array_agg(source_identity::jsonb->>'delivery') INTO cids FROM ${s}.shorts_delivery_packages
            WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id AND source_key IN (NEW.source_key,NEW.from_source_key);
        ELSE
          IF TG_OP='UPDATE' AND jsonb_build_array(OLD.body->'cid',OLD.body->'derivatives') IS NOT DISTINCT FROM jsonb_build_array(NEW.body->'cid',NEW.body->'derivatives') THEN RETURN NEW; END IF;
          cids=ARRAY[NEW.body->>'cid',NEW.body->'derivatives'->>'cid',NEW.body->'derivatives'->>'assetsCid'];
        END IF;
        FOR cid IN SELECT DISTINCT ${s}.shorts_cid_pin_identity(value) COLLATE "C" FROM unnest(cids) value WHERE value IS NOT NULL ORDER BY 1 LOOP
          PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||cid,0));
          IF EXISTS(SELECT FROM ${s}.shorts_input_reclamation_reservations WHERE input_cid=cid AND state<>'released') THEN
            RAISE EXCEPTION 'CID is reserved for input reclamation' USING ERRCODE='SH409';
          END IF;
        END LOOP;
        RETURN NEW;
      END $reference$;
      REVOKE ALL ON FUNCTION ${s}.shorts_cid_reference_guard() FROM PUBLIC;
      CREATE TRIGGER shorts_cid_reference_guard BEFORE INSERT OR UPDATE OF body ON ${s}.shorts_content FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_cid_reference_guard();
      CREATE TRIGGER shorts_cid_reference_guard BEFORE INSERT ON ${s}.shorts_delivery_generations FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_cid_reference_guard();
      CREATE TRIGGER shorts_cid_reference_guard BEFORE INSERT ON ${s}.shorts_delivery_packages FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_cid_reference_guard();
      CREATE TRIGGER shorts_cid_reference_guard BEFORE INSERT ON ${s}.shorts_delivery_selections FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_cid_reference_guard();

      CREATE FUNCTION ${s}.shorts_cid_policy_invalidation() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $policy$
      DECLARE post_id text; root_id text; net text; ctr text; cid text;
      BEGIN
        IF current_setting('transaction_isolation')<>'read committed' THEN
          RAISE EXCEPTION 'CID policy writes require READ COMMITTED' USING ERRCODE='SH400';
        END IF;
        IF TG_TABLE_NAME='shorts_content' THEN
          IF (NEW.body-ARRAY['views','likes','viewCount','likeCount','updatedAt']) IS NOT DISTINCT FROM (OLD.body-ARRAY['views','likes','viewCount','likeCount','updatedAt']) THEN RETURN NEW; END IF;
          post_id=NEW.id; root_id=NEW.id;
        ELSIF TG_TABLE_NAME='shorts_retention_holds' THEN
          IF NEW.released_at IS NOT NULL THEN RETURN NEW; END IF;
          root_id=NEW.resource_id;
          SELECT short_id INTO post_id FROM ${s}.shorts_delivery_generations WHERE network=NEW.network AND contract=NEW.contract AND job_id=root_id;
          post_id=COALESCE(post_id,root_id);
        ELSE
          IF NEW.status NOT IN ('queued','processing') THEN RETURN NEW; END IF;
          root_id=NEW.id; post_id=COALESCE(NEW.delivery_short_id,NEW.id);
        END IF;
        net=NEW.network; ctr=NEW.contract;
        -- Lock references even before a reservation exists: a hold and reserve
        -- racing each other must serialize regardless of which starts first.
        FOR cid IN SELECT DISTINCT value COLLATE "C" FROM (
          SELECT body->'derivatives'->>'cid' AS value FROM ${s}.shorts_content WHERE network=net AND contract=ctr AND id=post_id
          UNION ALL SELECT body->'derivatives'->>'cid' FROM ${s}.shorts_delivery_generations
            WHERE network=net AND contract=ctr AND (short_id=post_id OR job_id=root_id)
        ) refs WHERE value IS NOT NULL ORDER BY 1 LOOP
          PERFORM pg_advisory_xact_lock(hashtextextended('shorts-cid-v1:'||cid,0));
          UPDATE ${s}.shorts_input_reclamation_reservations SET state='invalidated' WHERE input_cid=cid AND state='reserved';
        END LOOP;
        RETURN NEW;
      END $policy$;
      REVOKE ALL ON FUNCTION ${s}.shorts_cid_policy_invalidation() FROM PUBLIC;
      CREATE TRIGGER shorts_cid_policy_invalidation AFTER UPDATE OF body ON ${s}.shorts_content FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_cid_policy_invalidation();
      CREATE TRIGGER shorts_cid_policy_invalidation AFTER INSERT ON ${s}.shorts_retention_holds FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_cid_policy_invalidation();
      CREATE TRIGGER shorts_cid_policy_invalidation AFTER INSERT OR UPDATE OF status ON ${s}.shorts_ingestion FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_cid_policy_invalidation()`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_input_reclamation_reservations IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_input_reclamation_reservations) AS used',
    );
    if (used)
      throw new Error('Preserve input reclamation history before rollback');
    for (const table of [
      'shorts_content',
      'shorts_delivery_generations',
      'shorts_delivery_packages',
      'shorts_delivery_selections',
    ])
      await db.query(`DROP TRIGGER shorts_cid_reference_guard ON ${table}`);
    for (const table of [
      'shorts_content',
      'shorts_retention_holds',
      'shorts_ingestion',
    ])
      await db.query(`DROP TRIGGER shorts_cid_policy_invalidation ON ${table}`);
    await db.query(`DROP TABLE shorts_input_reclamation_reservations;
      DROP FUNCTION shorts_cid_policy_invalidation(); DROP FUNCTION shorts_cid_reference_guard();
      DROP FUNCTION shorts_input_reclamation_reservation_guard(); DROP FUNCTION shorts_input_reclamation_roots(text);
      DROP INDEX shorts_content_input_cid; DROP INDEX shorts_content_assets_cid; DROP INDEX shorts_generation_original_cid;
      DROP INDEX shorts_content_pin_identity; DROP INDEX shorts_generation_pin_identity;
      DROP FUNCTION shorts_cid_pin_identity(text)`);
  }
}
