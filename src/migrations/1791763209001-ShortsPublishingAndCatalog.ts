import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

export class ShortsPublishingAndCatalog1791763209001 extends FeatureMigration {
  readonly changes = {
    ShortsPublications1791763209000: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE shorts_publishing_accounts (
      network varchar(32) NOT NULL, operator varchar(100) NOT NULL,
      policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
      paused boolean NOT NULL DEFAULT false,
      PRIMARY KEY(network,operator)
    )`);
        await runner.query(`CREATE TABLE shorts_publishing_contracts (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      operator varchar(100) NOT NULL, source_hash char(64) NOT NULL,
      PRIMARY KEY(network,contract), UNIQUE(network,contract,operator),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      FOREIGN KEY(network,operator) REFERENCES shorts_publishing_accounts(network,operator)
    )`);
        await runner.query(`CREATE TABLE shorts_publication_jobs (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      operator varchar(100) NOT NULL, creator varchar(100) NOT NULL, intent jsonb NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','claimed','signed','confirmed','reverted','cancelled','reconciled')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), lease_token uuid, lease_until timestamptz,
      raw_tx text CHECK(octet_length(raw_tx)<=32768), tx_hash varchar(100),
      nonce bigint CHECK(nonce>0), ttl bigint CHECK(ttl>0), signed_at timestamptz,
      reserved_cost numeric(78,0) CHECK(reserved_cost>0),
      broadcast_attempts integer NOT NULL DEFAULT 0 CHECK(broadcast_attempts>=0),
      last_broadcast_at timestamptz, broadcast_blocked boolean NOT NULL DEFAULT false,
      block_hash varchar(100), block_height bigint CHECK(block_height>=0),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract,operator) REFERENCES shorts_publishing_contracts(network,contract,operator),
      FOREIGN KEY(network,contract,id) REFERENCES shorts_content(network,contract,id),
      CHECK(jsonb_typeof(intent)='object' AND intent ?& ARRAY['id','creator','cid','bytes']
        AND intent->>'id'=id AND intent->>'creator'=creator),
      CHECK((lease_token IS NULL)=(lease_until IS NULL)),
      CHECK(status IN ('claimed','signed') OR lease_token IS NULL),
      CHECK((status='claimed')=(lease_token IS NOT NULL AND raw_tx IS NULL)),
      CHECK(CASE WHEN status IN ('signed','confirmed','reverted') THEN
        raw_tx IS NOT NULL AND tx_hash IS NOT NULL AND nonce IS NOT NULL AND ttl IS NOT NULL
        AND signed_at IS NOT NULL AND reserved_cost IS NOT NULL
        ELSE raw_tx IS NULL AND tx_hash IS NULL AND nonce IS NULL AND ttl IS NULL
        AND signed_at IS NULL AND reserved_cost IS NULL END),
      CHECK(CASE WHEN status IN ('confirmed','reverted','reconciled') THEN block_hash IS NOT NULL AND block_height IS NOT NULL
        ELSE block_hash IS NULL AND block_height IS NULL END)
    )`);
        await runner.query(`CREATE UNIQUE INDEX shorts_publication_active_account
      ON shorts_publication_jobs(network,operator) WHERE status IN ('claimed','signed');
      CREATE UNIQUE INDEX shorts_publication_nonce ON shorts_publication_jobs(network,operator,nonce) WHERE nonce IS NOT NULL;
      CREATE UNIQUE INDEX shorts_publication_hash ON shorts_publication_jobs(network,tx_hash) WHERE tx_hash IS NOT NULL;
      CREATE INDEX shorts_publication_queue ON shorts_publication_jobs(network,operator,created_at,id) WHERE status='queued';
      CREATE INDEX shorts_publication_budget ON shorts_publication_jobs(network,operator,signed_at) WHERE signed_at IS NOT NULL`);
      },
      async down(runner: QueryRunner): Promise<void> {
        const [{ n }] = await runner.query(
          'SELECT count(*)::integer AS n FROM shorts_publishing_accounts',
        );
        if (n)
          throw new Error(
            'Reconcile and preserve the signed publication journal before rollback',
          );
        await runner.query('DROP TABLE shorts_publication_jobs');
        await runner.query('DROP TABLE shorts_publishing_contracts');
        await runner.query('DROP TABLE shorts_publishing_accounts');
      },
    },

    /** Public API and signer use distinct logins with no direct journal grants. */
    ShortsPublisherAuthority1791763210000: {
      async up(runner: QueryRunner): Promise<void> {
        const [{ schema }] = await runner.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await runner.query(`CREATE TABLE ${s}.shorts_publisher_principals (
      role_oid oid PRIMARY KEY, role_name name NOT NULL UNIQUE,
      kind varchar(16) NOT NULL CHECK(kind IN ('api','publisher')),
      network varchar(32) NOT NULL CHECK(network='ae_uat'), contract varchar(100) NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_publishing_contracts(network,contract)
    ); ALTER TABLE ${s}.shorts_publication_jobs ADD COLUMN lease_principal oid`);
        await runner.query(`CREATE FUNCTION ${s}.shorts_publication(action text,payload jsonb)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $publisher$
    DECLARE
      login pg_catalog.pg_roles%ROWTYPE;
      principal ${s}.shorts_publisher_principals%ROWTYPE;
      binding ${s}.shorts_publishing_contracts%ROWTYPE;
      account ${s}.shorts_publishing_accounts%ROWTYPE;
      job ${s}.shorts_publication_jobs%ROWTYPE;
      record jsonb; intent jsonb; result jsonb; allowed boolean; pending integer; own integer;
      current_nonce bigint; reserved numeric; cost numeric; next_nonce bigint; height bigint; expiry bigint; changed integer; budget_since timestamptz;
    BEGIN
      IF action IS NULL OR action NOT IN ('verify','enqueue','status','claim','persist','authorize','renew','release','settle','reconcile')
        OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR octet_length(payload::text)>65536 THEN
        RAISE EXCEPTION 'Invalid publication request' USING ERRCODE='SH400';
      END IF;
      SELECT * INTO login FROM pg_catalog.pg_roles WHERE rolname=session_user;
      SELECT * INTO principal FROM ${s}.shorts_publisher_principals WHERE role_oid=login.oid AND role_name=session_user AND enabled;
      IF NOT FOUND OR NOT login.rolcanlogin OR login.rolsuper OR login.rolcreaterole OR login.rolcreatedb
        OR login.rolreplication OR login.rolbypassrls OR EXISTS(SELECT FROM pg_catalog.pg_auth_members WHERE member=login.oid) THEN
        RAISE EXCEPTION 'Dedicated publication login required' USING ERRCODE='SH401';
      END IF;
      IF EXISTS(SELECT FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND pg_catalog.has_schema_privilege(login.oid,n.oid,'CREATE'))
        OR pg_catalog.has_database_privilege(login.oid,current_database(),'CREATE')
        OR EXISTS(WITH RECURSIVE protected(oid) AS (
          SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=${"'" + String(schema).replaceAll("'", "''") + "'"}
            AND c.relname IN ('shorts_publisher_principals','shorts_publishing_accounts','shorts_publishing_contracts','shorts_publication_jobs')
          UNION SELECT rw.ev_class FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_rewrite rw
            ON d.classid='pg_catalog.pg_rewrite'::regclass AND d.objid=rw.oid
            JOIN protected p ON d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=p.oid
          ) SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
          AND (principal.kind='publisher' OR c.oid IN (SELECT oid FROM protected))
          AND (pg_catalog.has_table_privilege(login.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(login.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        OR EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
          AND p.oid<>'${s.replaceAll("'", "''")}.shorts_publication(text,jsonb)'::regprocedure
          AND pg_catalog.has_function_privilege(login.oid,p.oid,'EXECUTE')) THEN
        RAISE EXCEPTION 'Publication login has excessive privileges' USING ERRCODE='SH401';
      END IF;
      SELECT * INTO binding FROM ${s}.shorts_publishing_contracts WHERE network=principal.network AND contract=principal.contract;
      IF NOT FOUND OR payload->>'network' IS DISTINCT FROM principal.network OR payload->>'contract' IS DISTINCT FROM principal.contract
        OR payload->>'sourceHash' IS DISTINCT FROM binding.source_hash::text
        OR NOT EXISTS(SELECT FROM ${s}.shorts_runtime r WHERE r.network=binding.network AND r.contract=binding.contract AND r.source_hash=binding.source_hash) THEN
        RAISE EXCEPTION 'Publication deployment mismatch' USING ERRCODE='SH401';
      END IF;
      SELECT * INTO account FROM ${s}.shorts_publishing_accounts WHERE network=binding.network AND operator=binding.operator FOR UPDATE;
      IF payload->>'operator' IS DISTINCT FROM binding.operator OR payload->'policy' IS DISTINCT FROM account.policy THEN
        RAISE EXCEPTION 'Configured publisher identity or policy changed' USING ERRCODE='SH401';
      END IF;
      IF action='verify' THEN RETURN jsonb_build_object('kind',principal.kind,'operator',binding.operator,'policy',account.policy); END IF;
      IF (principal.kind='api' AND action NOT IN ('enqueue','status'))
        OR (principal.kind='publisher' AND action NOT IN ('claim','persist','authorize','renew','release','settle','reconcile')) THEN
        RAISE EXCEPTION 'Publication action outside role' USING ERRCODE='SH401';
      END IF;

      IF principal.kind='api' THEN
        IF payload->>'id' IS NULL OR payload->>'id' !~ '^[a-zA-Z0-9-]{1,80}$'
          OR payload->>'creator' IS NULL OR payload->>'creator' !~ '^ak_[a-zA-Z0-9]{1,97}$' THEN
          RAISE EXCEPTION 'Invalid publication identity' USING ERRCODE='SH400';
        END IF;
        SELECT body INTO record FROM ${s}.shorts_content WHERE network=binding.network AND contract=binding.contract AND id=payload->>'id' FOR UPDATE;
        IF NOT FOUND OR record->>'creator' IS DISTINCT FROM payload->>'creator' THEN
          RAISE EXCEPTION 'Creator access required' USING ERRCODE='SH401';
        END IF;
        SELECT * INTO job FROM ${s}.shorts_publication_jobs WHERE network=binding.network AND contract=binding.contract AND id=payload->>'id' FOR UPDATE;
        IF action='status' THEN
          IF NOT FOUND THEN RETURN NULL; END IF;
          RETURN jsonb_build_object('id',job.id,'status',job.status,'transactionHash',job.tx_hash,'blockHash',job.block_hash,'height',job.block_height);
        END IF;
        intent=jsonb_build_object('id',record->'id','creator',record->'creator','cid',record->'cid','bytes',record->'bytes');
        IF job.id IS NOT NULL THEN
          IF job.intent IS DISTINCT FROM intent THEN RAISE EXCEPTION 'Immutable publication identity' USING ERRCODE='SH409'; END IF;
          RETURN jsonb_build_object('id',job.id,'status',job.status,'transactionHash',job.tx_hash,'blockHash',job.block_hash,'height',job.block_height);
        END IF;
        IF account.paused THEN RAISE EXCEPTION 'Publication paused' USING ERRCODE='SH503'; END IF;
        IF record->>'publication' IS DISTINCT FROM 'pending' OR record->>'moderation' IS DISTINCT FROM 'approved'
          OR NOT coalesce(record->'safety'->>'status'='no_flags' OR (record->'safety'->>'status'='review'
            AND length(record->'safety'->>'evidenceHash')>0 AND record->>'visualReviewHash'=record->'safety'->>'evidenceHash'),false) THEN
          RAISE EXCEPTION 'Current approval required' USING ERRCODE='SH401';
        END IF;
        IF record->>'cid' IS NULL OR record->>'cid' !~ '^[a-zA-Z0-9]{1,120}$' OR jsonb_typeof(record->'bytes') IS DISTINCT FROM 'number'
          OR record->>'bytes' !~ '^[1-9][0-9]{0,8}$' OR (record->>'bytes')::bigint>100000000 THEN
          RAISE EXCEPTION 'Invalid publication media' USING ERRCODE='SH400';
        END IF;
        SELECT count(*),count(*) FILTER(WHERE creator=payload->>'creator') INTO pending,own FROM ${s}.shorts_publication_jobs
          WHERE network=binding.network AND operator=binding.operator AND status IN ('queued','claimed','signed');
        IF pending>=(account.policy->>'maxPending')::integer OR own>=(account.policy->>'maxCreatorPending')::integer THEN
          RAISE EXCEPTION 'Publication queue full' USING ERRCODE='SH503';
        END IF;
        INSERT INTO ${s}.shorts_publication_jobs(network,contract,id,operator,creator,intent)
          VALUES(binding.network,binding.contract,payload->>'id',binding.operator,payload->>'creator',intent);
        RETURN jsonb_build_object('id',payload->>'id','status','queued');
      END IF;

      IF action='claim' THEN
        SELECT * INTO job FROM ${s}.shorts_publication_jobs WHERE network=binding.network AND operator=binding.operator
          AND status IN ('claimed','signed') FOR UPDATE;
        IF FOUND AND (job.contract<>binding.contract OR job.lease_until>clock_timestamp()) THEN RETURN NULL; END IF;
        IF job.id IS NULL THEN
          IF account.paused THEN RETURN NULL; END IF;
          SELECT * INTO job FROM ${s}.shorts_publication_jobs WHERE network=binding.network AND contract=binding.contract
            AND status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE;
          IF NOT FOUND THEN RETURN NULL; END IF;
        END IF;
        SELECT body INTO record FROM ${s}.shorts_content WHERE network=binding.network AND contract=binding.contract AND id=job.id FOR UPDATE;
        allowed=coalesce(record->>'publication'='pending' AND record->>'moderation'='approved'
          AND (record->'safety'->>'status'='no_flags' OR (record->'safety'->>'status'='review'
            AND length(record->'safety'->>'evidenceHash')>0 AND record->>'visualReviewHash'=record->'safety'->>'evidenceHash'))
          AND jsonb_build_object('id',record->'id','creator',record->'creator','cid',record->'cid','bytes',record->'bytes')=job.intent,false);
        IF job.status<>'signed' AND NOT allowed THEN
          UPDATE ${s}.shorts_publication_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,lease_principal=NULL,updated_at=clock_timestamp()
            WHERE network=job.network AND contract=job.contract AND id=job.id;
          RETURN NULL;
        END IF;
        UPDATE ${s}.shorts_publication_jobs SET status=CASE WHEN raw_tx IS NULL THEN 'claimed' ELSE 'signed' END,
          fence=fence+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+(account.policy->>'leaseMs')::integer*interval '1 millisecond',
          lease_principal=principal.role_oid,updated_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND id=job.id RETURNING * INTO job;
        RETURN jsonb_build_object('id',job.id,'token',job.lease_token,'fence',job.fence::text,'intent',job.intent,'status',job.status,
          'rawTransaction',job.raw_tx,'transactionHash',job.tx_hash,'nonce',job.nonce,'ttl',job.ttl,'reservedCost',job.reserved_cost::text,
          'broadcastBlocked',job.broadcast_blocked);
      END IF;

      SELECT * INTO job FROM ${s}.shorts_publication_jobs WHERE network=binding.network AND contract=binding.contract AND id=payload->>'id' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Unknown publication' USING ERRCODE='SH409'; END IF;
      IF action='settle' AND job.status IN ('confirmed','reverted') THEN
        IF job.tx_hash IS DISTINCT FROM payload->>'transactionHash' OR job.block_hash IS DISTINCT FROM payload->>'blockHash'
          OR job.block_height::text IS DISTINCT FROM payload->>'height'
          OR job.status IS DISTINCT FROM (CASE WHEN payload->>'result'='ok' THEN 'confirmed' ELSE 'reverted' END)
          OR payload->>'result' IS NULL OR payload->>'result' NOT IN ('ok','revert','error')
          OR payload->>'tipHeight' IS NULL OR payload->>'tipHeight' !~ '^[0-9]{1,15}$'
          OR (payload->>'tipHeight')::bigint-job.block_height<(account.policy->>'confirmations')::integer THEN
          RAISE EXCEPTION 'Publication observation conflicts' USING ERRCODE='SH409';
        END IF;
        RETURN jsonb_build_object('status',job.status);
      END IF;
      IF job.status NOT IN ('claimed','signed') OR job.lease_principal IS DISTINCT FROM principal.role_oid
        OR job.lease_token::text IS DISTINCT FROM payload->>'token' OR job.fence::text IS DISTINCT FROM payload->>'fence'
        OR job.lease_until IS NULL OR job.lease_until<=clock_timestamp() THEN
        RAISE EXCEPTION 'Publication lease expired or replaced' USING ERRCODE='SH409';
      END IF;
      IF action='renew' THEN
        UPDATE ${s}.shorts_publication_jobs SET lease_until=clock_timestamp()+(account.policy->>'leaseMs')::integer*interval '1 millisecond',updated_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND id=job.id;
        RETURN '{}'::jsonb;
      ELSIF action='release' THEN
        UPDATE ${s}.shorts_publication_jobs SET status=CASE WHEN raw_tx IS NULL THEN 'queued' ELSE 'signed' END,
          lease_token=NULL,lease_until=NULL,lease_principal=NULL,updated_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND id=job.id;
        RETURN '{}'::jsonb;
      END IF;
      SELECT body INTO record FROM ${s}.shorts_content WHERE network=binding.network AND contract=binding.contract AND id=job.id FOR UPDATE;
      IF job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Publication lease expired' USING ERRCODE='SH409'; END IF;
      allowed=coalesce(record->>'publication'='pending' AND record->>'moderation'='approved'
        AND (record->'safety'->>'status'='no_flags' OR (record->'safety'->>'status'='review'
          AND length(record->'safety'->>'evidenceHash')>0 AND record->>'visualReviewHash'=record->'safety'->>'evidenceHash'))
        AND jsonb_build_object('id',record->'id','creator',record->'creator','cid',record->'cid','bytes',record->'bytes')=job.intent,false);
      IF action='reconcile' THEN
        IF job.status<>'claimed' OR account.paused OR NOT allowed OR payload->'intent' IS DISTINCT FROM job.intent
          OR payload->>'blockHash' IS NULL OR payload->>'blockHash' !~ '^kh_[a-zA-Z0-9]{1,97}$'
          OR payload->>'height' IS NULL OR payload->>'height' !~ '^[0-9]{1,15}$'
          OR payload->>'tipHeight' IS NULL OR payload->>'tipHeight' !~ '^[0-9]{1,15}$' THEN
          RAISE EXCEPTION 'Invalid existing publication observation' USING ERRCODE='SH400';
        END IF;
        IF (payload->>'tipHeight')::bigint-(payload->>'height')::bigint<(account.policy->>'confirmations')::integer THEN
          RAISE EXCEPTION 'Insufficient publication confirmations' USING ERRCODE='SH409';
        END IF;
        UPDATE ${s}.shorts_publication_jobs SET status='reconciled',block_hash=payload->>'blockHash',
          block_height=(payload->>'height')::bigint,lease_token=NULL,lease_until=NULL,lease_principal=NULL,updated_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND id=job.id AND lease_until>clock_timestamp();
      ELSIF action='persist' THEN
        IF payload->'intent' IS DISTINCT FROM job.intent THEN RAISE EXCEPTION 'Publication intent changed' USING ERRCODE='SH409'; END IF;
        IF job.status='signed' THEN
          IF job.raw_tx IS DISTINCT FROM payload->>'rawTransaction' THEN RAISE EXCEPTION 'Signed bytes cannot change' USING ERRCODE='SH409'; END IF;
          RETURN jsonb_build_object('transactionHash',job.tx_hash,'blockHash',job.block_hash,'height',job.block_height);
        END IF;
        IF account.paused OR NOT allowed THEN RAISE EXCEPTION 'Publication is no longer authorized' USING ERRCODE='SH401'; END IF;
        IF payload->>'rawTransaction' IS NULL OR payload->>'rawTransaction' !~ '^tx_[A-Za-z0-9+/=]+$'
          OR octet_length(payload->>'rawTransaction')>32768 OR payload->>'transactionHash' IS NULL
          OR payload->>'transactionHash' !~ '^th_[a-zA-Z0-9]{1,97}$'
          OR payload->>'nonce' IS NULL OR payload->>'nonce' !~ '^[1-9][0-9]{0,14}$'
          OR payload->>'accountNonce' IS NULL OR payload->>'accountNonce' !~ '^[0-9]{1,15}$'
          OR payload->>'height' IS NULL OR payload->>'height' !~ '^[0-9]{1,15}$'
          OR payload->>'ttl' IS NULL OR payload->>'ttl' !~ '^[1-9][0-9]{0,14}$'
          OR payload->>'cost' IS NULL OR payload->>'cost' !~ '^[1-9][0-9]{0,59}$' THEN
          RAISE EXCEPTION 'Invalid signed publication fields' USING ERRCODE='SH400';
        END IF;
        next_nonce=(payload->>'nonce')::bigint; height=(payload->>'height')::bigint; expiry=(payload->>'ttl')::bigint; cost=(payload->>'cost')::numeric;
        IF next_nonce<>(payload->>'accountNonce')::bigint+1 OR expiry<=height OR expiry>height+(account.policy->>'maxTtlBlocks')::integer
          OR cost>(account.policy->>'maxTransactionCost')::numeric THEN RAISE EXCEPTION 'Publication bounds exceeded' USING ERRCODE='SH400'; END IF;
        SELECT nonce INTO current_nonce FROM ${s}.shorts_publication_jobs WHERE network=binding.network AND operator=binding.operator
          AND nonce IS NOT NULL ORDER BY nonce DESC LIMIT 1;
        budget_since=clock_timestamp()-interval '24 hours';
        SELECT coalesce(sum(reserved_cost),0) INTO reserved FROM ${s}.shorts_publication_jobs
          WHERE network=binding.network AND operator=binding.operator AND (signed_at>budget_since OR status='signed');
        IF current_nonce IS NOT NULL AND (payload->>'accountNonce')::bigint<current_nonce THEN RAISE EXCEPTION 'Node nonce behind journal' USING ERRCODE='SH409'; END IF;
        IF reserved+cost>(account.policy->>'rollingCostLimit')::numeric THEN RAISE EXCEPTION 'Publication spending limit' USING ERRCODE='SH503'; END IF;
        UPDATE ${s}.shorts_publication_jobs SET status='signed',raw_tx=payload->>'rawTransaction',tx_hash=payload->>'transactionHash',
          nonce=next_nonce,ttl=expiry,reserved_cost=cost,signed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND id=job.id AND lease_until>clock_timestamp();
      ELSIF action='authorize' THEN
        IF job.status<>'signed' THEN RAISE EXCEPTION 'Persist before sending' USING ERRCODE='SH409'; END IF;
        IF account.paused THEN RETURN NULL; END IF;
        IF job.broadcast_blocked OR NOT allowed THEN
          UPDATE ${s}.shorts_publication_jobs SET broadcast_blocked=true,updated_at=clock_timestamp()
            WHERE network=job.network AND contract=job.contract AND id=job.id;
          RETURN NULL;
        END IF;
        UPDATE ${s}.shorts_publication_jobs SET broadcast_attempts=broadcast_attempts+1,last_broadcast_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND id=job.id AND lease_until>clock_timestamp();
      ELSIF action='settle' THEN
        IF job.status<>'signed' OR payload->>'transactionHash' IS DISTINCT FROM job.tx_hash
          OR payload->>'blockHash' IS NULL OR payload->>'blockHash' !~ '^mh_[a-zA-Z0-9]{1,97}$'
          OR payload->>'height' IS NULL OR payload->>'height' !~ '^[0-9]{1,15}$'
          OR payload->>'tipHeight' IS NULL OR payload->>'tipHeight' !~ '^[0-9]{1,15}$'
          OR payload->>'result' IS NULL OR payload->>'result' NOT IN ('ok','revert','error') THEN
          RAISE EXCEPTION 'Invalid publication observation' USING ERRCODE='SH400';
        END IF;
        IF (payload->>'tipHeight')::bigint-(payload->>'height')::bigint<(account.policy->>'confirmations')::integer THEN
          RAISE EXCEPTION 'Insufficient publication confirmations' USING ERRCODE='SH409';
        END IF;
        UPDATE ${s}.shorts_publication_jobs SET status=CASE WHEN payload->>'result'='ok' THEN 'confirmed' ELSE 'reverted' END,
          block_hash=payload->>'blockHash',block_height=(payload->>'height')::bigint,lease_token=NULL,lease_until=NULL,lease_principal=NULL,updated_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND id=job.id AND lease_until>clock_timestamp();
      END IF;
      GET DIAGNOSTICS changed=ROW_COUNT;
      IF changed<>1 THEN RAISE EXCEPTION 'Publication lease expired' USING ERRCODE='SH409'; END IF;
      IF action='authorize' THEN
        RETURN jsonb_build_object('id',job.id,'status',job.status,'intent',job.intent,'rawTransaction',job.raw_tx,
          'transactionHash',job.tx_hash,'nonce',job.nonce,'ttl',job.ttl,'reservedCost',job.reserved_cost::text);
      END IF;
      RETURN jsonb_build_object('transactionHash',coalesce(job.tx_hash,payload->>'transactionHash'));
    END $publisher$`);
        await runner.query(`REVOKE ALL ON FUNCTION ${s}.shorts_publication(text,jsonb) FROM PUBLIC;
      REVOKE ALL ON ${s}.shorts_publisher_principals,${s}.shorts_publishing_accounts,${s}.shorts_publishing_contracts,${s}.shorts_publication_jobs FROM PUBLIC`);
      },
      async down(runner: QueryRunner): Promise<void> {
        const [{ n }] = await runner.query(
          'SELECT count(*)::integer AS n FROM shorts_publisher_principals',
        );
        if (n)
          throw new Error(
            'Disable and reconcile publication principals before removing their boundary',
          );
        await runner.query('DROP FUNCTION shorts_publication(text,jsonb)');
        await runner.query(
          'ALTER TABLE shorts_publication_jobs DROP COLUMN lease_principal',
        );
        await runner.query('DROP TABLE shorts_publisher_principals');
      },
    },

    ShortsCatalog1791763211000: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE INDEX shorts_content_public_page
      ON shorts_content(network,contract,created_at DESC,id DESC)
      WHERE body->>'publication'='published' AND body->>'moderation'='approved'`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP INDEX shorts_content_public_page');
      },
    },

    ShortsStudio1791763212000: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE INDEX shorts_chain_events_video
      ON shorts_chain_events(contract,beneficiary,short_id,action,block_height)
      WHERE short_id IS NOT NULL`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP INDEX shorts_chain_events_video');
      },
    },

    ShortsLifecycle1791763213000: {
      async up(runner: QueryRunner): Promise<void> {
        const [{ schema }] = await runner.query(
          'SELECT current_schema() AS schema',
        );
        const s = `"${String(schema).replaceAll('"', '""')}"`;
        await runner.query(`CREATE TABLE ${s}.shorts_lifecycle_jobs (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
      fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
      lease_token uuid, lease_until timestamptz,
      next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 16),
      checked_at timestamptz,
      result varchar(24) CHECK(result IN ('checked','publication_pending','retention_pending','reconciliation_required','failed')),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract,id) REFERENCES ${s}.shorts_content(network,contract,id) ON DELETE CASCADE,
      CHECK((lease_token IS NULL)=(lease_until IS NULL))
    );
    CREATE INDEX shorts_lifecycle_due ON ${s}.shorts_lifecycle_jobs(network,contract,next_at,id)`);
        await runner.query(`CREATE FUNCTION ${s}.shorts_schedule_lifecycle() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $lifecycle$
      BEGIN
        IF TG_OP='UPDATE' AND
          jsonb_build_array(OLD.body->'publication',OLD.body->'moderation',OLD.body->'safety',
            OLD.body->'visualReviewHash',OLD.body->'scanGeneration') IS NOT DISTINCT FROM
          jsonb_build_array(NEW.body->'publication',NEW.body->'moderation',NEW.body->'safety',
            NEW.body->'visualReviewHash',NEW.body->'scanGeneration') THEN RETURN NEW; END IF;
        INSERT INTO ${s}.shorts_lifecycle_jobs(network,contract,id) VALUES(NEW.network,NEW.contract,NEW.id)
          ON CONFLICT(network,contract,id) DO UPDATE SET generation=${s}.shorts_lifecycle_jobs.generation+1,
            lease_token=NULL,lease_until=NULL,next_at=clock_timestamp(),attempts=0,result=NULL;
        RETURN NEW;
      END $lifecycle$;
      REVOKE ALL ON FUNCTION ${s}.shorts_schedule_lifecycle() FROM PUBLIC;
      CREATE TRIGGER shorts_schedule_lifecycle AFTER INSERT OR UPDATE OF body ON ${s}.shorts_content
      FOR EACH ROW EXECUTE FUNCTION ${s}.shorts_schedule_lifecycle();
      INSERT INTO ${s}.shorts_lifecycle_jobs(network,contract,id) SELECT network,contract,id FROM ${s}.shorts_content`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query(
          'DROP TRIGGER shorts_schedule_lifecycle ON shorts_content',
        );
        await runner.query('DROP FUNCTION shorts_schedule_lifecycle()');
        await runner.query('DROP TABLE shorts_lifecycle_jobs');
      },
    },

    ShortsSharedCutover1791763214000: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE shorts_legacy_cutovers (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      fingerprint char(64) NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
      completed_at timestamptz,
      PRIMARY KEY(network,contract),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    );
    CREATE INDEX shorts_content_missing_private ON shorts_content(network,contract,id)
      WHERE body->'privateMedia' IS NULL OR body->'privateMedia'='null'::jsonb`);
      },
      async down(runner: QueryRunner): Promise<void> {
        const [row] = await runner.query(
          'SELECT 1 FROM shorts_legacy_cutovers LIMIT 1',
        );
        if (row)
          throw new Error('Preserve legacy cutover evidence before downgrade');
        await runner.query(
          'DROP INDEX shorts_content_missing_private; DROP TABLE shorts_legacy_cutovers',
        );
      },
    },

    ShortsFollowing1791763227000: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE INDEX shorts_content_following_page
      ON shorts_content(network,contract,creator,created_at DESC,id DESC)
      WHERE body->>'publication'='published' AND body->>'moderation'='approved'`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP INDEX shorts_content_following_page');
      },
    },
  };
}
