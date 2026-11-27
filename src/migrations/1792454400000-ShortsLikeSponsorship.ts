import { MigrationInterface, QueryRunner } from 'typeorm';

/** No login is enrolled and no sponsorship is enabled by this migration. */
export class ShortsLikeSponsorship1792454400000 implements MigrationInterface {
  async up(db: QueryRunner) {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    await db.query(`CREATE TABLE ${s}.shorts_like_sponsor_accounts(
      network text NOT NULL CHECK(network='ae_uat'), payer text NOT NULL,
      policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'), paused boolean NOT NULL DEFAULT true,
      quarantined boolean NOT NULL DEFAULT false, quarantine_reason jsonb, anchor_version bigint NOT NULL DEFAULT 0,
      anchor_contract text, anchor_inner_hash text,
      PRIMARY KEY(network,payer));
    CREATE TABLE ${s}.shorts_like_sponsor_deployments(
      network text NOT NULL, contract text NOT NULL, source_hash char(64) NOT NULL, payer text NOT NULL,
      PRIMARY KEY(network,contract), FOREIGN KEY(network,payer) REFERENCES ${s}.shorts_like_sponsor_accounts,
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_runtime(network,contract));
    CREATE TABLE ${s}.shorts_like_sponsor_principals(
      role_oid oid PRIMARY KEY, role_name name NOT NULL UNIQUE,
      kind text NOT NULL CHECK(kind IN ('api','signer')), enabled boolean NOT NULL DEFAULT true,
      network text NOT NULL, contract text NOT NULL,
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_like_sponsor_deployments);
    CREATE TABLE ${s}.shorts_like_sponsorship_jobs(
      network text NOT NULL, contract text NOT NULL, inner_hash text NOT NULL, request_id uuid NOT NULL,
      payer text NOT NULL, actor text NOT NULL, video_id text NOT NULL, raw_inner text NOT NULL CHECK(octet_length(raw_inner)<=8192),
      intent jsonb NOT NULL, status text NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','claimed','signed','confirmed','failed','rejected','expired','recovering')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), signed_at timestamptz,
      raw_outer text CHECK(octet_length(raw_outer)<=16384), outer_hash text, payer_nonce bigint, reserved_cost numeric(78,0),
      prepared_outer text CHECK(octet_length(prepared_outer)<=16384), prepared_nonce bigint, prepared_cost numeric(78,0), prepared_at timestamptz,
      lease_token uuid, lease_until timestamptz, fence bigint NOT NULL DEFAULT 0, lease_principal oid,
      block_hash text, block_height bigint, result text, expiry_proof jsonb,
      settlement_history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(settlement_history)='array'),
      last_broadcast_at timestamptz, broadcast_attempts integer NOT NULL DEFAULT 0,
      PRIMARY KEY(network,contract,inner_hash), UNIQUE(network,contract,actor,request_id),
      FOREIGN KEY(network,contract) REFERENCES ${s}.shorts_like_sponsor_deployments,
      FOREIGN KEY(network,payer) REFERENCES ${s}.shorts_like_sponsor_accounts,
      CHECK((prepared_outer IS NULL)=(prepared_nonce IS NULL)),
      CHECK((prepared_outer IS NULL)=(prepared_cost IS NULL)),
      CHECK((prepared_outer IS NULL)=(prepared_at IS NULL)),
      CHECK(raw_outer IS NULL OR (prepared_outer IS NOT NULL AND payer_nonce=prepared_nonce AND reserved_cost=prepared_cost)),
      CHECK((raw_outer IS NULL)=(outer_hash IS NULL)),
      CHECK((raw_outer IS NULL)=(payer_nonce IS NULL)),
      CHECK((raw_outer IS NULL)=(reserved_cost IS NULL)),
      CHECK((raw_outer IS NULL)=(signed_at IS NULL)),
      CHECK((lease_token IS NULL)=(lease_until IS NULL)),
      CHECK((status IN ('signed','confirmed','failed','expired','recovering'))=(raw_outer IS NOT NULL)),
      CHECK((status='expired')=(expiry_proof IS NOT NULL)),
      CHECK((status IN ('confirmed','failed'))=(block_hash IS NOT NULL)));
    CREATE UNIQUE INDEX shorts_like_sponsor_prepared_nonce ON ${s}.shorts_like_sponsorship_jobs(network,payer,prepared_nonce) WHERE prepared_nonce IS NOT NULL AND status NOT IN ('expired','rejected','recovering');
    CREATE UNIQUE INDEX shorts_like_sponsor_nonce ON ${s}.shorts_like_sponsorship_jobs(network,payer,payer_nonce) WHERE payer_nonce IS NOT NULL AND status NOT IN ('expired','recovering');
    CREATE UNIQUE INDEX shorts_like_sponsor_active ON ${s}.shorts_like_sponsorship_jobs(network,payer) WHERE status IN ('claimed','signed');
    CREATE UNIQUE INDEX shorts_like_sponsor_member ON ${s}.shorts_like_sponsorship_jobs(network,contract,actor,video_id) WHERE status NOT IN ('rejected','expired','failed','recovering');
    CREATE INDEX shorts_like_sponsor_budget ON ${s}.shorts_like_sponsorship_jobs(network,payer,created_at);
    CREATE INDEX shorts_like_sponsor_queue ON ${s}.shorts_like_sponsorship_jobs(network,payer,created_at) WHERE status='queued'`);
    await db.query(`CREATE FUNCTION ${s}.shorts_like_sponsorship(action text,payload jsonb)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $sponsor$
    DECLARE login pg_catalog.pg_roles%ROWTYPE; principal ${s}.shorts_like_sponsor_principals%ROWTYPE;
      binding ${s}.shorts_like_sponsor_deployments%ROWTYPE; account ${s}.shorts_like_sponsor_accounts%ROWTYPE;
      job ${s}.shorts_like_sponsorship_jobs%ROWTYPE; n integer; own integer; spent numeric; prior_nonce bigint;
    BEGIN
      IF action IS NULL OR action NOT IN ('verify','enqueue','status','claim','reserve','persist','authorize','settle','release','reject','expire','anchor','quarantine','claim_recovery','recovery_status','recovery_finish')
        OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR octet_length(payload::text)>40000
        THEN RAISE EXCEPTION 'Invalid sponsorship request' USING ERRCODE='SH400'; END IF;
      SELECT * INTO login FROM pg_catalog.pg_roles WHERE rolname=session_user;
      SELECT * INTO principal FROM ${s}.shorts_like_sponsor_principals WHERE role_oid=login.oid AND role_name=session_user AND enabled;
      IF NOT FOUND OR NOT login.rolcanlogin OR login.rolsuper OR login.rolcreaterole OR login.rolcreatedb
        OR login.rolreplication OR login.rolbypassrls
        OR EXISTS(SELECT FROM pg_catalog.pg_auth_members WHERE member=login.oid)
        OR pg_catalog.has_database_privilege(login.oid,current_database(),'CREATE')
        OR EXISTS(SELECT FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND pg_catalog.has_schema_privilege(login.oid,n.oid,'CREATE'))
        OR EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
          AND (pg_catalog.has_table_privilege(login.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(login.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
        OR EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
          AND p.oid<>'${s.replaceAll("'", "''")}.shorts_like_sponsorship(text,jsonb)'::regprocedure
          AND pg_catalog.has_function_privilege(login.oid,p.oid,'EXECUTE'))
        THEN RAISE EXCEPTION 'Dedicated restricted sponsorship login required' USING ERRCODE='SH401'; END IF;
      SELECT * INTO binding FROM ${s}.shorts_like_sponsor_deployments WHERE network=principal.network AND contract=principal.contract;
      IF NOT FOUND OR payload->>'network' IS DISTINCT FROM binding.network OR payload->>'contract' IS DISTINCT FROM binding.contract
        OR payload->>'sourceHash' IS DISTINCT FROM binding.source_hash::text OR payload->>'payer' IS DISTINCT FROM binding.payer
        OR NOT EXISTS(SELECT FROM ${s}.shorts_runtime WHERE network=binding.network AND contract=binding.contract AND source_hash=binding.source_hash)
        THEN RAISE EXCEPTION 'Sponsorship deployment mismatch' USING ERRCODE='SH401'; END IF;
      SELECT * INTO account FROM ${s}.shorts_like_sponsor_accounts WHERE network=binding.network AND payer=binding.payer FOR UPDATE;
      IF payload->'policy' IS DISTINCT FROM account.policy THEN RAISE EXCEPTION 'Sponsorship policy mismatch' USING ERRCODE='SH401'; END IF;
      IF action='verify' THEN RETURN jsonb_build_object('kind',principal.kind,'paused',account.paused,'quarantined',account.quarantined); END IF;
      IF (principal.kind='api' AND action NOT IN ('enqueue','status'))
        OR (principal.kind='signer' AND action NOT IN ('claim','reserve','persist','authorize','settle','release','reject','expire','anchor','quarantine','claim_recovery','recovery_status','recovery_finish'))
        THEN RAISE EXCEPTION 'Sponsorship role boundary' USING ERRCODE='SH401'; END IF;
      IF action='anchor' THEN
        IF account.anchor_inner_hash IS NOT NULL THEN
          SELECT * INTO job FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network
            AND contract=account.anchor_contract AND inner_hash=account.anchor_inner_hash;
          IF NOT FOUND OR job.status NOT IN ('confirmed','failed','expired') THEN RAISE EXCEPTION 'Invalid sponsorship anchor' USING ERRCODE='SH409'; END IF;
        ELSIF EXISTS(SELECT FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND payer=binding.payer AND status IN ('confirmed','failed','expired')) THEN
          RAISE EXCEPTION 'Existing settlement history requires explicit recovery' USING ERRCODE='SH409';
        END IF;
        RETURN jsonb_build_object('version',account.anchor_version,'quarantined',account.quarantined,'paused',account.paused,
          'job',CASE WHEN job.inner_hash IS NULL THEN NULL ELSE to_jsonb(job)||jsonb_build_object('reserved_cost',job.reserved_cost::text) END);
      END IF;
      IF action='recovery_status' THEN
        SELECT count(*) INTO n FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND payer=binding.payer AND status IN ('recovering','signed','claimed');
        RETURN jsonb_build_object('quarantined',account.quarantined,'paused',account.paused,'remaining',n,'version',account.anchor_version);
      END IF;
      IF action IN ('claim','reserve','persist','authorize','settle','expire','claim_recovery','recovery_finish','quarantine')
        AND payload->>'anchorVersion' IS DISTINCT FROM account.anchor_version::text
        THEN RAISE EXCEPTION 'Sponsorship canonical anchor changed' USING ERRCODE='SH409'; END IF;
      IF (action IN ('claim_recovery','recovery_finish') OR (action='quarantine' AND payload->>'reason'='bootstrap'))
        AND (payload->>'recovery' IS DISTINCT FROM 'true' OR payload->>'admissionEnabled' IS DISTINCT FROM 'false')
        THEN RAISE EXCEPTION 'Explicit recovery with admission disabled required' USING ERRCODE='SH401'; END IF;
      IF action='quarantine' THEN
        IF payload->>'reason' NOT IN ('anchor_changed','bootstrap') OR payload->>'reason' IS NULL
          THEN RAISE EXCEPTION 'Invalid quarantine reason' USING ERRCODE='SH400'; END IF;
        UPDATE ${s}.shorts_like_sponsor_accounts SET quarantined=true,anchor_version=anchor_version+1,
          anchor_contract=NULL,anchor_inner_hash=NULL,quarantine_reason=jsonb_build_object('at',clock_timestamp(),'reason',payload->>'reason','previousAnchor',account.anchor_inner_hash)
          WHERE network=binding.network AND payer=binding.payer;
        UPDATE ${s}.shorts_like_sponsorship_jobs SET settlement_history=settlement_history||jsonb_build_array(jsonb_build_object(
          'at',clock_timestamp(),'status',status,'blockHash',block_hash,'height',block_height,'result',result,'expiryProof',expiry_proof)),
          status=CASE WHEN raw_outer IS NULL THEN 'rejected' ELSE 'recovering' END,
          block_hash=NULL,block_height=NULL,result=NULL,expiry_proof=NULL,
          lease_token=NULL,lease_until=NULL,lease_principal=NULL,fence=fence+1
          WHERE network=binding.network AND payer=binding.payer AND (raw_outer IS NOT NULL OR status='claimed');
        RETURN NULL;
      END IF;
      IF action='recovery_finish' THEN
        IF NOT account.quarantined OR EXISTS(SELECT FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND payer=binding.payer AND status IN ('recovering','signed','claimed'))
          THEN RAISE EXCEPTION 'Recovery remains unresolved' USING ERRCODE='SH409'; END IF;
        UPDATE ${s}.shorts_like_sponsor_accounts SET quarantined=false,paused=true,anchor_version=anchor_version+1
          WHERE network=binding.network AND payer=binding.payer;
        RETURN NULL;
      END IF;
      IF action IN ('enqueue','status') THEN
        IF payload->>'actor' IS NULL OR payload->>'actor' !~ '^ak_[a-zA-Z0-9]{1,97}$'
          OR payload->>'innerHash' IS NULL OR payload->>'innerHash' !~ '^th_[a-zA-Z0-9]{1,97}$'
          THEN RAISE EXCEPTION 'Invalid sponsorship identity' USING ERRCODE='SH400'; END IF;
        SELECT * INTO job FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND contract=binding.contract AND inner_hash=payload->>'innerHash';
        IF job.inner_hash IS NOT NULL AND job.actor IS DISTINCT FROM payload->>'actor'
          THEN RAISE EXCEPTION 'Sponsorship actor mismatch' USING ERRCODE='SH401'; END IF;
        IF action='enqueue' THEN
          IF payload->>'id' IS NULL OR payload->>'id' !~ '^[a-fA-F0-9-]{36}$'
            OR payload->>'rawInner' IS NULL OR octet_length(payload->>'rawInner')>8192
            OR payload->>'videoId' IS NULL OR payload->>'videoId' !~ '^[a-zA-Z0-9_-]{1,128}$'
            OR jsonb_typeof(payload->'intent') IS DISTINCT FROM 'object'
            THEN RAISE EXCEPTION 'Invalid sponsorship body' USING ERRCODE='SH400'; END IF;
          IF job.inner_hash IS NOT NULL THEN
            IF job.raw_inner IS DISTINCT FROM payload->>'rawInner' OR job.video_id IS DISTINCT FROM payload->>'videoId'
              OR job.request_id IS DISTINCT FROM (payload->>'id')::uuid OR job.intent IS DISTINCT FROM payload->'intent'
              THEN RAISE EXCEPTION 'Immutable sponsorship identity' USING ERRCODE='SH409'; END IF;
          ELSE
            SELECT count(*) INTO n FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND payer=binding.payer AND status IN ('queued','claimed','signed');
            IF n >= (account.policy->>'maxPending')::integer THEN RAISE EXCEPTION 'Queue full' USING ERRCODE='SH503'; END IF;
            SELECT count(*),count(*) FILTER(WHERE actor=payload->>'actor') INTO n,own FROM ${s}.shorts_like_sponsorship_jobs
              WHERE network=binding.network AND payer=binding.payer AND created_at>clock_timestamp()-interval '24 hours';
            IF n >= (account.policy->>'maxRequestsPerDay')::integer OR own >= (account.policy->>'maxActorPerDay')::integer
              THEN RAISE EXCEPTION 'Daily request limit' USING ERRCODE='SH503'; END IF;
            INSERT INTO ${s}.shorts_like_sponsorship_jobs(network,contract,inner_hash,request_id,payer,actor,video_id,raw_inner,intent,status)
              VALUES(binding.network,binding.contract,payload->>'innerHash',(payload->>'id')::uuid,binding.payer,payload->>'actor',payload->>'videoId',payload->>'rawInner',payload->'intent',
                CASE WHEN account.paused OR account.quarantined OR payload->>'admissionEnabled' IS DISTINCT FROM 'true' THEN 'rejected' ELSE 'queued' END)
              RETURNING * INTO job;
          END IF;
        END IF;
        IF job.inner_hash IS NULL THEN RETURN NULL; END IF;
        RETURN jsonb_build_object('innerHash',job.inner_hash,'actor',job.actor,'videoId',job.video_id,
          'intent',job.intent,'status',job.status,'outerHash',job.outer_hash,'expiryProof',job.expiry_proof);
      END IF;
      IF action IN ('claim','claim_recovery') THEN
        IF (action='claim' AND account.quarantined) OR (action='claim_recovery' AND NOT account.quarantined) THEN RETURN NULL; END IF;
        SELECT * INTO job FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND payer=binding.payer
          AND (status IN ('claimed','signed') OR (action='claim_recovery' AND status='recovering')) ORDER BY payer_nonce NULLS LAST,created_at LIMIT 1 FOR UPDATE;
        IF job.inner_hash IS NOT NULL AND job.lease_until>clock_timestamp() THEN RETURN NULL; END IF;
        IF job.inner_hash IS NULL THEN
          IF action='claim_recovery' OR account.paused OR payload->>'admissionEnabled' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
          SELECT * INTO job FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND payer=binding.payer
            AND contract=binding.contract AND status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE;
        END IF;
        IF job.inner_hash IS NULL OR job.contract<>binding.contract THEN RETURN NULL; END IF;
        UPDATE ${s}.shorts_like_sponsorship_jobs SET status=CASE WHEN raw_outer IS NULL THEN 'claimed' WHEN account.quarantined THEN 'recovering' ELSE 'signed' END,
          fence=fence+1,lease_token=(payload->>'token')::uuid,lease_principal=principal.role_oid,lease_until=clock_timestamp()+interval '60 seconds'
          WHERE network=job.network AND contract=job.contract AND inner_hash=job.inner_hash RETURNING * INTO job;
        RETURN to_jsonb(job)||jsonb_build_object('prepared_cost',job.prepared_cost::text,'reserved_cost',job.reserved_cost::text);
      END IF;
      SELECT * INTO job FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND contract=binding.contract
        AND inner_hash=payload->>'innerHash' FOR UPDATE;
      IF NOT FOUND OR job.status NOT IN ('claimed','signed','recovering') OR job.lease_token IS NULL OR job.lease_until IS NULL OR job.lease_principal IS DISTINCT FROM principal.role_oid
        OR job.lease_token IS DISTINCT FROM (payload->>'token')::uuid OR job.fence IS DISTINCT FROM (payload->>'fence')::bigint
        OR job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Sponsorship lease changed' USING ERRCODE='SH409'; END IF;
      IF action='release' THEN
        UPDATE ${s}.shorts_like_sponsorship_jobs SET status=CASE WHEN raw_outer IS NOT NULL AND account.quarantined THEN 'recovering' WHEN raw_outer IS NOT NULL THEN 'signed' WHEN prepared_outer IS NOT NULL THEN 'claimed' ELSE 'queued' END,
          lease_token=NULL,lease_until=NULL,lease_principal=NULL WHERE network=job.network AND contract=job.contract AND inner_hash=job.inner_hash;
        RETURN NULL;
      END IF;
      IF action='reject' THEN
        IF job.raw_outer IS NOT NULL THEN RAISE EXCEPTION 'Signed sponsor transaction must be reconciled' USING ERRCODE='SH409'; END IF;
        UPDATE ${s}.shorts_like_sponsorship_jobs SET status='rejected',lease_token=NULL,lease_until=NULL,lease_principal=NULL
          WHERE network=job.network AND contract=job.contract AND inner_hash=job.inner_hash;
        RETURN NULL;
      END IF;
      IF action='reserve' THEN
        IF account.paused OR account.quarantined OR payload->>'admissionEnabled' IS DISTINCT FROM 'true' OR job.raw_outer IS NOT NULL
          THEN RAISE EXCEPTION 'Sponsorship admission paused' USING ERRCODE='SH409'; END IF;
        IF payload->>'unsignedOuter' IS NULL OR octet_length(payload->>'unsignedOuter')>16384
          OR payload->>'nonce' IS NULL OR payload->>'nonce' !~ '^[1-9][0-9]{0,14}$'
          OR payload->>'cost' IS NULL OR payload->>'cost' !~ '^[1-9][0-9]{0,59}$'
          OR (payload->>'cost')::numeric > (account.policy->>'maxTransactionCost')::numeric
          THEN RAISE EXCEPTION 'Invalid sponsor reservation' USING ERRCODE='SH400'; END IF;
        IF job.prepared_outer IS NOT NULL THEN
          IF job.prepared_outer IS DISTINCT FROM payload->>'unsignedOuter' OR job.prepared_nonce IS DISTINCT FROM (payload->>'nonce')::bigint
            OR job.prepared_cost IS DISTINCT FROM (payload->>'cost')::numeric
            THEN RAISE EXCEPTION 'Immutable sponsor reservation' USING ERRCODE='SH409'; END IF;
          RETURN to_jsonb(job)||jsonb_build_object('prepared_cost',job.prepared_cost::text,'reserved_cost',job.reserved_cost::text);
        END IF;
        SELECT max(prepared_nonce) INTO prior_nonce FROM ${s}.shorts_like_sponsorship_jobs
          WHERE network=binding.network AND payer=binding.payer AND status NOT IN ('expired','rejected');
        IF prior_nonce IS NOT NULL AND (payload->>'nonce')::bigint<=prior_nonce THEN RAISE EXCEPTION 'Sponsor nonce behind journal' USING ERRCODE='SH409'; END IF;
        SELECT coalesce(sum(prepared_cost),0) INTO spent FROM ${s}.shorts_like_sponsorship_jobs WHERE network=binding.network AND payer=binding.payer
          AND (prepared_at>clock_timestamp()-interval '24 hours' OR status IN ('claimed','signed','recovering'));
        IF spent+(payload->>'cost')::numeric>(account.policy->>'rollingCostLimit')::numeric
          THEN RAISE EXCEPTION 'Sponsorship spending limit' USING ERRCODE='SH503'; END IF;
        UPDATE ${s}.shorts_like_sponsorship_jobs SET prepared_outer=payload->>'unsignedOuter',prepared_nonce=(payload->>'nonce')::bigint,
          prepared_cost=(payload->>'cost')::numeric,prepared_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND inner_hash=job.inner_hash RETURNING * INTO job;
        RETURN to_jsonb(job)||jsonb_build_object('prepared_cost',job.prepared_cost::text,'reserved_cost',job.reserved_cost::text);
      END IF;
      IF action='persist' THEN
        IF account.paused OR account.quarantined OR payload->>'admissionEnabled' IS DISTINCT FROM 'true' OR job.raw_outer IS NOT NULL
          THEN RAISE EXCEPTION 'Sponsorship paused or already signed' USING ERRCODE='SH409'; END IF;
        IF job.prepared_outer IS NULL OR job.prepared_outer IS DISTINCT FROM payload->>'unsignedOuter'
          OR payload->>'rawOuter' IS NULL OR octet_length(payload->>'rawOuter')>16384
          OR payload->>'outerHash' IS NULL OR payload->>'outerHash' !~ '^th_[a-zA-Z0-9]{1,97}$'
          OR payload->>'nonce' IS DISTINCT FROM job.prepared_nonce::text
          OR payload->>'cost' IS DISTINCT FROM job.prepared_cost::text
          THEN RAISE EXCEPTION 'Persist exact reserved envelope' USING ERRCODE='SH409'; END IF;
        UPDATE ${s}.shorts_like_sponsorship_jobs SET status='signed',raw_outer=payload->>'rawOuter',outer_hash=payload->>'outerHash',
          payer_nonce=prepared_nonce,reserved_cost=prepared_cost,signed_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND inner_hash=job.inner_hash RETURNING * INTO job;
        RETURN to_jsonb(job)||jsonb_build_object('prepared_cost',job.prepared_cost::text,'reserved_cost',job.reserved_cost::text);
      END IF;
      IF job.raw_outer IS NULL THEN RAISE EXCEPTION 'Persist before broadcast' USING ERRCODE='SH409'; END IF;
      IF action='expire' THEN
        IF jsonb_typeof(payload->'expiryProof') IS DISTINCT FROM 'object'
          OR payload->'expiryProof'->>'ttl' IS DISTINCT FROM job.intent->>'ttl'
          OR payload->'expiryProof'->>'height' IS NULL OR payload->'expiryProof'->>'height' !~ '^[0-9]{1,15}$'
          OR (payload->'expiryProof'->>'height')::bigint < (job.intent->>'ttl')::bigint+3
          OR (payload->'expiryProof'->>'payerNonce' = (job.payer_nonce-1)::text OR (account.quarantined AND payload->'expiryProof'->>'reservedNonce'=job.payer_nonce::text AND payload->'expiryProof'->>'payerNonce' ~ '^[0-9]{1,15}$' AND (payload->'expiryProof'->>'payerNonce')::bigint < job.payer_nonce)) IS DISTINCT FROM true
          OR payload->'expiryProof'->>'blockHash' IS NULL OR payload->'expiryProof'->>'blockHash' !~ '^kh_[a-zA-Z0-9]{1,97}$'
          THEN RAISE EXCEPTION 'Invalid expiry proof' USING ERRCODE='SH400'; END IF;
        UPDATE ${s}.shorts_like_sponsorship_jobs SET status='expired',expiry_proof=payload->'expiryProof',
          lease_token=NULL,lease_until=NULL,lease_principal=NULL WHERE network=job.network AND contract=job.contract AND inner_hash=job.inner_hash;
        UPDATE ${s}.shorts_like_sponsor_accounts SET anchor_contract=job.contract,anchor_inner_hash=job.inner_hash,anchor_version=anchor_version+1
          WHERE network=binding.network AND payer=binding.payer;
        RETURN NULL;
      END IF;
      IF action='authorize' THEN
        IF account.paused OR (account.quarantined AND (payload->>'recovery' IS DISTINCT FROM 'true' OR payload->>'admissionEnabled' IS DISTINCT FROM 'false')) OR (job.last_broadcast_at IS NOT NULL AND job.last_broadcast_at>clock_timestamp()-interval '30 seconds') THEN RETURN 'false'::jsonb; END IF;
        UPDATE ${s}.shorts_like_sponsorship_jobs SET last_broadcast_at=clock_timestamp(),broadcast_attempts=broadcast_attempts+1
          WHERE network=job.network AND contract=job.contract AND inner_hash=job.inner_hash;
        RETURN 'true'::jsonb;
      END IF;
      IF action='settle' THEN
        IF payload->>'outerHash' IS DISTINCT FROM job.outer_hash OR payload->>'blockHash' IS NULL OR payload->>'blockHash' !~ '^mh_[a-zA-Z0-9]{1,97}$'
          OR payload->>'height' IS NULL OR payload->>'height' !~ '^[0-9]{1,15}$'
          OR payload->>'result' IS NULL OR payload->>'result' NOT IN ('ok','error','revert')
          THEN RAISE EXCEPTION 'Invalid settlement evidence' USING ERRCODE='SH400'; END IF;
        UPDATE ${s}.shorts_like_sponsorship_jobs SET status=CASE WHEN payload->>'result'='ok' THEN 'confirmed' ELSE 'failed' END,
          block_hash=payload->>'blockHash',block_height=(payload->>'height')::bigint,result=payload->>'result',
          lease_token=NULL,lease_until=NULL,lease_principal=NULL WHERE network=job.network AND contract=job.contract AND inner_hash=job.inner_hash;
        UPDATE ${s}.shorts_like_sponsor_accounts SET anchor_contract=job.contract,anchor_inner_hash=job.inner_hash,anchor_version=anchor_version+1
          WHERE network=binding.network AND payer=binding.payer;
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'Invalid sponsorship operation' USING ERRCODE='SH400';
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Sponsorship identity already reserved' USING ERRCODE='SH409';
    END $sponsor$;
    REVOKE ALL ON FUNCTION ${s}.shorts_like_sponsorship(text,jsonb) FROM PUBLIC;
    REVOKE ALL ON ${s}.shorts_like_sponsor_accounts,${s}.shorts_like_sponsor_deployments,${s}.shorts_like_sponsor_principals,${s}.shorts_like_sponsorship_jobs FROM PUBLIC`);
  }
  async down() {
    throw new Error(
      'Preserve sponsorship journals and reservations; use a forward migration',
    );
  }
}
