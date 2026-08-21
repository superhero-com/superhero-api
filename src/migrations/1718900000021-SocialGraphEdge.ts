import { MigrationInterface, QueryRunner } from 'typeorm';

export class SocialGraphEdge1718900000021 implements MigrationInterface {
  name = 'SocialGraphEdge1718900000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "social_graph_edges" (
        "id" SERIAL NOT NULL,
        "from_address" character varying NOT NULL,
        "to_address" character varying NOT NULL,
        "kind" character varying NOT NULL,
        "height" integer NOT NULL,
        "tx_hash" character varying NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT "PK_social_graph_edges_id" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_social_graph_edge" ON "social_graph_edges" ("from_address", "to_address", "kind")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_social_graph_edge_to_kind" ON "social_graph_edges" ("to_address", "kind")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_social_graph_edge_to_kind"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_social_graph_edge"`);
    await queryRunner.query(`DROP TABLE "social_graph_edges"`);
  }
}
