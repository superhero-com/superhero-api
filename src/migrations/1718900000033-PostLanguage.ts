import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the detected script/language column to `posts`, plus a composite index
 * for the content-language filter.
 *
 * Purely additive: a new nullable column with no default and a new index. No
 * existing column or row is altered, and the column is not `NOT NULL`, so
 * adding it does not rewrite the table. Existing rows stay `null` (meaning "not
 * yet processed") until the backfill script fills them.
 *
 * Production runs migrations on boot with `synchronize` forced off (see
 * `DB_SYNC_ENABLED` in `src/configs/database.ts`), so this file is the only
 * thing that creates the column there. Dev and testnet boot with `DB_SYNC=true`
 * and may have already created it from the entity — hence `IF NOT EXISTS`, so
 * running this against such a database is a no-op rather than an error.
 */
export class PostLanguage1718900000033 implements MigrationInterface {
  name = 'PostLanguage1718900000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "language" character varying(8)`,
    );
    // Serves `GET /api/posts?language=` and the popular-feed language filter.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_POSTS_LANGUAGE_CREATED_AT"
         ON "posts" ("language", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_POSTS_LANGUAGE_CREATED_AT"`,
    );
    await queryRunner.query(
      `ALTER TABLE "posts" DROP COLUMN IF EXISTS "language"`,
    );
  }
}
