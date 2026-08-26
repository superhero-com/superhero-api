import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `Post` has declared IDX_POSTS_CREATED_AT all along but no migration ever
 * created it, so it exists only where `synchronize` once ran and plans differ
 * between environments. IF NOT EXISTS makes this a no-op where that drift
 * already supplied it. Seventeen other entity indexes are in the same state.
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
