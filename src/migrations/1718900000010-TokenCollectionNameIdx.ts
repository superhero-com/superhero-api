import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `GET /tokens?collection=<name>` (tokens.controller.ts) filters with
 * `LOWER(split_part(token.collection, '-ak_', 1)) = LOWER(:collectionName)`
 * so a collection name (e.g. "CHINESE") matches every network's id for that
 * collection without the caller needing the `-ak_...` suffix. Index the same
 * expression so that filter doesn't fall back to a sequential scan as the
 * token table grows.
 */
export class TokenCollectionNameIdx1718900000010 implements MigrationInterface {
  name = 'TokenCollectionNameIdx1718900000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_token_collection_name" ON "token" (LOWER(split_part("collection", '-ak_', 1)))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_token_collection_name"`);
  }
}
