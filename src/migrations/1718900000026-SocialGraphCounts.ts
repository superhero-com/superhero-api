import { MigrationInterface, QueryRunner } from 'typeorm';

export class SocialGraphCounts1718900000026 implements MigrationInterface {
  name = 'SocialGraphCounts1718900000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "social_graph_counts" (
        "address" character varying NOT NULL,
        "followers_count" integer NOT NULL DEFAULT 0,
        "following_count" integer NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_social_graph_counts_address" PRIMARY KEY ("address"),
        CONSTRAINT "CHK_social_graph_counts_non_negative"
          CHECK ("followers_count" >= 0 AND "following_count" >= 0)
      )`,
    );

    // Backfill from the edge table: a follow edge contributes to its target's
    // followers and its source's following. Merge both aggregates on address so
    // an address that only follows and one that is only followed each get a row.
    await queryRunner.query(
      `INSERT INTO "social_graph_counts" ("address", "followers_count", "following_count", "updated_at")
       SELECT
         addr,
         COALESCE(SUM("followers_count"), 0),
         COALESCE(SUM("following_count"), 0),
         now()
       FROM (
         SELECT "to_address"   AS addr, COUNT(*) AS "followers_count", 0 AS "following_count"
           FROM "social_graph_edges" WHERE "kind" = 'follow' GROUP BY "to_address"
         UNION ALL
         SELECT "from_address" AS addr, 0 AS "followers_count", COUNT(*) AS "following_count"
           FROM "social_graph_edges" WHERE "kind" = 'follow' GROUP BY "from_address"
       ) AS merged
       GROUP BY addr`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "social_graph_counts"`);
  }
}
