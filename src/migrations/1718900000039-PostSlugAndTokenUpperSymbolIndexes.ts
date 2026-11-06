import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two lookups that read a whole table on every call:
 * - `GET /api/posts/:id` matches `post.id = :id OR post.slug = :id`; without a
 *   `slug` index the OR can't be served from indexes, so `posts` is scanned.
 * - Trend-mention enrichment (posts list, popular, detail) matches
 *   `UPPER(token.symbol) IN (...)`, which the plain `symbol` index can't serve,
 *   so `token` is scanned.
 *
 * Plain (non-CONCURRENTLY) creation, per this folder's convention -- see
 * TokenUnlistedCreatedAtIndex1718900000018 for why CONCURRENTLY is rejected.
 * `IF NOT EXISTS` because `DB_SYNC=true` environments may already have
 * `IDX_POSTS_SLUG` from the entity. The expression index is declared with
 * `synchronize: false`, so this migration is the only thing that creates it.
 */
export class PostSlugAndTokenUpperSymbolIndexes1718900000039 implements MigrationInterface {
  name = 'PostSlugAndTokenUpperSymbolIndexes1718900000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_POSTS_SLUG" ON "posts" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TOKEN_UPPER_SYMBOL" ON "token" (UPPER("symbol"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TOKEN_UPPER_SYMBOL"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_POSTS_SLUG"`);
  }
}
