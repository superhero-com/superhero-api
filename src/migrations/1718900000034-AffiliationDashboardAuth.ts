import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Credentials and sessions for the internal affiliation dashboards.
 *
 * Those pages join wallet address to X handle, follower count, payout amount
 * and transaction hash, and until now were readable by anyone who guessed the
 * URL. They need a login, and the login needs somewhere to keep its password.
 *
 * Not an environment variable: the operators of this deployment cannot set
 * them. Not a hash committed to the repository: that can be attacked offline
 * by anyone with read access, which would rule out the short, memorable
 * password they asked for. A row in this database is the only place the hash is
 * neither unsettable nor public.
 *
 * Purely additive: two new tables and their indexes. No existing table, column
 * or row is altered, renamed or dropped, and nothing already running reads or
 * writes either table, so this cannot change the behaviour of anything
 * currently live.
 *
 * Production runs migrations on boot with `synchronize` forced off (see
 * `DB_SYNC_ENABLED` in `src/configs/database.ts`), so this file is the only
 * thing that creates these tables there. Dev and testnet boot with
 * `DB_SYNC=true` and may have already created them from the entities — hence
 * `IF NOT EXISTS` throughout, so running this against such a database is a
 * no-op rather than an error.
 *
 * No admin row is seeded. The first person to reach the setup page after a
 * deploy chooses the credentials, so the password never exists anywhere but
 * this table, hashed.
 */
export class AffiliationDashboardAuth1718900000034 implements MigrationInterface {
  name = 'AffiliationDashboardAuth1718900000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "affiliation_dashboard_admins" (
         "id" SERIAL NOT NULL,
         "username" character varying(64) NOT NULL,
         "password_hash" character varying(255) NOT NULL,
         "failed_login_count" integer NOT NULL DEFAULT 0,
         "locked_until" TIMESTAMP,
         "last_login_at" TIMESTAMP,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "pk_affiliation_dashboard_admins" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_affiliation_dashboard_admins_username"
         ON "affiliation_dashboard_admins" ("username")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "affiliation_dashboard_sessions" (
         "id" SERIAL NOT NULL,
         "admin_id" integer NOT NULL,
         "token_hash" character varying(64) NOT NULL,
         "expires_at" TIMESTAMP NOT NULL,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "pk_affiliation_dashboard_sessions" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_affiliation_dashboard_sessions_token"
         ON "affiliation_dashboard_sessions" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_affiliation_dashboard_sessions_expires"
         ON "affiliation_dashboard_sessions" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping these logs everyone out and discards the credentials, which is
    // the intended meaning of reverting this migration: the dashboards go back
    // to having no login. They also go back to being unguarded, so a revert
    // should be paired with reverting the guard.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_affiliation_dashboard_sessions_expires"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_affiliation_dashboard_sessions_token"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "affiliation_dashboard_sessions"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_affiliation_dashboard_admins_username"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "affiliation_dashboard_admins"`,
    );
  }
}
