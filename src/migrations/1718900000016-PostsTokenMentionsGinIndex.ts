import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the `token_mentions @> '["SYMBOL"]'` containment checks
 * (`buildTokenMentionExistsSql`) used by trending-metrics/eligibility
 * lookups, which previously fell back to a per-row
 * `jsonb_array_elements_text` scan of every post. `jsonb_path_ops` is
 * smaller and faster than the default GIN opclass for `@>`-only workloads
 * (no key-existence `?`/`?|`/`?&` queries are run against this column).
 *
 * TypeORM's `@Index` decorator cannot express `USING GIN` + opclass, so
 * this index is migration-only (see `community_room.moderators`/`muted`
 * for the existing precedent) with no matching entity decorator.
 * `CONCURRENTLY` cannot run inside a transaction, hence `transaction = false`.
 */
export class PostsTokenMentionsGinIndex1718900000016
  implements MigrationInterface
{
  name = 'PostsTokenMentionsGinIndex1718900000016';
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_POSTS_TOKEN_MENTIONS_GIN" ON "posts" USING GIN ("token_mentions" jsonb_path_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_POSTS_TOKEN_MENTIONS_GIN"`,
    );
  }
}
