import { MigrationInterface, QueryRunner } from 'typeorm';

/** Acknowledging a replacement never selects it for public playback. */
export class ShortsGenerationDeliveryPackages1793145605000 implements MigrationInterface {
  private async guard(db: QueryRunner, reverse: boolean) {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    const [{ definition }] = await db.query(
      "SELECT pg_get_functiondef('shorts_delivery_package_guard()'::regprocedure) AS definition",
    );
    const initial =
      '        PERFORM ' + s + '.shorts_validate_original(content);';
    const replacement = `        generation_job=NEW.source_identity::jsonb #>> '{generation,job}';
        IF generation_job IS DISTINCT FROM NEW.short_id THEN
          canonical=content;
          SELECT body INTO content FROM ${s}.shorts_delivery_generations
            WHERE network=NEW.network AND contract=NEW.contract AND short_id=NEW.short_id AND job_id=generation_job FOR SHARE;
          IF NOT FOUND OR content->'cid' IS DISTINCT FROM canonical->'cid'
            OR content->'bytes' IS DISTINCT FROM canonical->'bytes'
            OR content->'original' IS DISTINCT FROM canonical->'original' THEN
            RAISE EXCEPTION 'Accepted delivery generation missing or original changed' USING ERRCODE='SH409';
          END IF;
        END IF;
${initial}`;
    const edits = [
      [
        'DECLARE content jsonb; expected jsonb;',
        'DECLARE content jsonb; expected jsonb; canonical jsonb; generation_job text;',
      ],
      [initial, replacement],
      [
        'Delivery acknowledgement differs from original generation',
        'Delivery acknowledgement differs from accepted generation',
      ],
    ];
    let next = definition;
    for (const [before, after] of edits) {
      const from = reverse ? after : before,
        to = reverse ? before : after;
      if (next.split(from).length !== 2)
        throw new Error('Unexpected delivery acknowledgement guard');
      next = next.replace(from, to);
    }
    await db.query(next);
  }
  async up(db: QueryRunner): Promise<void> {
    await db.query(`ALTER TABLE shorts_delivery_packages
      DROP CONSTRAINT shorts_delivery_packages_network_contract_short_id_key,
      ADD COLUMN generation_job_id varchar(80) GENERATED ALWAYS AS ((source_identity::jsonb #>> '{generation,job}')) STORED NOT NULL,
      ADD CONSTRAINT shorts_delivery_package_generation UNIQUE(network,contract,short_id,generation_job_id);
      CREATE INDEX shorts_delivery_package_generation_root ON shorts_delivery_packages(network,contract,generation_job_id)`);
    await this.guard(db, false);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_delivery_packages IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] = await db.query(
      'SELECT EXISTS(SELECT FROM shorts_delivery_packages WHERE generation_job_id<>short_id) AS used',
    );
    if (used)
      throw new Error(
        'Preserve acknowledged generation history before rollback',
      );
    await this.guard(db, true);
    await db.query(`ALTER TABLE shorts_delivery_packages DROP COLUMN generation_job_id,
      ADD CONSTRAINT shorts_delivery_packages_network_contract_short_id_key UNIQUE(network,contract,short_id)`);
  }
}
