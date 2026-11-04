import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProfileMedia1792954800000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`
      CREATE TABLE profile_media_auth (
        scope text NOT NULL, id text NOT NULL, address varchar(100) NOT NULL,
        kind text NOT NULL CHECK(kind IN ('challenge','session')),
        message text, expires_at timestamptz NOT NULL,
        PRIMARY KEY(scope,id));
      CREATE INDEX profile_media_auth_expiry ON profile_media_auth(expires_at);
      CREATE TABLE profile_media_rates (
        scope text NOT NULL, key text NOT NULL, bucket bigint NOT NULL,
        count integer NOT NULL CHECK(count>0), expires_at timestamptz NOT NULL,
        PRIMARY KEY(scope,key,bucket));
      CREATE TABLE profile_media_slots (
        scope text NOT NULL, slot integer NOT NULL CHECK(slot BETWEEN 0 AND 1),
        lease uuid NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(scope,slot));
      CREATE TABLE profile_media_uploads (
        scope text NOT NULL, id uuid NOT NULL, address varchar(100) NOT NULL,
        role text NOT NULL CHECK(role IN ('avatar','cover')), bytes integer NOT NULL CHECK(bytes>0 AND bytes<=10485760),
        sha256 varchar(64) NOT NULL, parts jsonb NOT NULL DEFAULT '{}',
        state text NOT NULL CHECK(state IN ('uploading','queued','processing','ready','failed')),
        cid varchar(100), error text, attempts integer NOT NULL DEFAULT 0,
        lease uuid, lease_until timestamptz, expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(scope,id));
      CREATE INDEX profile_media_uploads_queue ON profile_media_uploads(scope,state,created_at);
      CREATE TABLE profile_media_assets (
        scope text NOT NULL, cid varchar(100) NOT NULL, address varchar(100) NOT NULL,
        role text NOT NULL CHECK(role IN ('avatar','cover')),
        files jsonb NOT NULL, bytes integer NOT NULL CHECK(bytes>0),
        ready boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_linked_at timestamptz, replaced_at timestamptz,
        PRIMARY KEY(scope,cid));
      CREATE INDEX profile_media_assets_owner ON profile_media_assets(scope,address,role);
      CREATE TABLE profile_media_writes (
        scope text NOT NULL, id uuid NOT NULL, address varchar(100) NOT NULL,
        role text NOT NULL CHECK(role IN ('avatar','cover')), cid varchar(100),
        nonce bigint NOT NULL CHECK(nonce>=0), message text NOT NULL,
        state text NOT NULL CHECK(state IN ('prepared','signed','submitted','confirmed','failed')),
        signed_tx text, tx_hash varchar(100), error text,
        expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,id));
      CREATE INDEX profile_media_writes_pending ON profile_media_writes(scope,state);
    `);
  }
  async down(): Promise<void> {
    throw new Error(
      'Profile media keeps published references and transaction history; use a reviewed forward migration',
    );
  }
}
