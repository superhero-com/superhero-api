import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `Post` (`post.entity.ts`) declares `@Index('IDX_POSTS_POST_ID', ['post_id'])`
 * but no migration ever created it — with `synchronize` off in production the
 * index never landed. The recursive thread CTE joins `posts` on `post_id` for
 * up to 10k popular candidates per level, so without this index it degrades
 * into repeated sequential scans as the table grows.
 *
 * `IF NOT EXISTS` (and `IF EXISTS` on the way down) because this is an
 * entity-declared index on the pre-existing, entity-managed `posts` table:
 * any environment that ever ran with `synchronize: true` (dev/testnet, or a
 * schema the migration tests build from entities) already has it, and a bare
 * `CREATE INDEX` would fail there and block the whole migration chain. On
 * production (synchronize off) the index is absent and gets created here.
 */
export class PostsPostIdIdx1718900000011 implements MigrationInterface {
  name = 'PostsPostIdIdx1718900000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_POSTS_POST_ID" ON "posts" ("post_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_POSTS_POST_ID"`,
    );
  }
}
