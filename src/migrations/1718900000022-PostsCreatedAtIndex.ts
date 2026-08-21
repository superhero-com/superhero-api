import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Codifies `posts(created_at)`, which `Post` has declared via
 * `@Index('IDX_POSTS_CREATED_AT', ...)` all along but no migration ever
 * created. It exists today only as `synchronize` drift (the same drift
 * DropRedundantAccountAddressIndex1718900000013 describes), so it is present
 * wherever `synchronize` once ran and absent anywhere the schema came from
 * migrations alone -- an inconsistency that makes query plans differ between
 * environments for no visible reason.
 *
 * It backs the `ORDER BY created_at DESC LIMIT n` on the post search, the
 * popular-feed recent fallback, and the plain post listing. Confirmed via
 * EXPLAIN that the search query plans as `Index Scan Backward using
 * IDX_POSTS_CREATED_AT` rather than a seq scan + sort when it is present.
 *
 * `IF NOT EXISTS` makes this a no-op wherever the drift already provided it,
 * so this is safe to apply everywhere; the point is to stop relying on drift.
 * Seventeen other named entity indexes are in the same position -- see the
 * `@Index` decorators that have no matching migration -- and are deliberately
 * left for a separate reconciliation pass rather than bundled here.
 */
export class PostsCreatedAtIndex1718900000022 implements MigrationInterface {
  name = 'PostsCreatedAtIndex1718900000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_POSTS_CREATED_AT" ON "posts" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_POSTS_CREATED_AT"`,
    );
  }
}
