import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Resume state for the social-graph one-shot recovery backfill. A first walk over
 * a call history larger than the page-safety window stops at the newest ~5,000
 * calls; without these columns the next boot restarts from the newest page and
 * truncates at the same point, so the oldest calls are never reached.
 *
 * `resume_from_height` records the generation the next boot resumes the
 * newest-first walk at (scope gen:<this>-0), and `pending_high_height` carries
 * the highest block seen so it can be promoted to `last_backfilled_height` once
 * the walk finally completes. Both are null in steady state.
 */
export class SocialGraphBackfillResumeState1718900000030 implements MigrationInterface {
  name = 'SocialGraphBackfillResumeState1718900000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "social_graph_backfill_state"
         ADD COLUMN IF NOT EXISTS "resume_from_height" integer,
         ADD COLUMN IF NOT EXISTS "pending_high_height" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "social_graph_backfill_state"
         DROP COLUMN IF EXISTS "pending_high_height",
         DROP COLUMN IF EXISTS "resume_from_height"`,
    );
  }
}
