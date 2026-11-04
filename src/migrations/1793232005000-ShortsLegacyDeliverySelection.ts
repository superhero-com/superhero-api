import { MigrationInterface, QueryRunner } from 'typeorm';

/** Select source-bound legacy upgrades without rewriting canonical publication. */
export class ShortsLegacyDeliverySelection1793232005000 implements MigrationInterface {
  private async guards(db: QueryRunner, reverse: boolean) {
    const [{ schema }] = await db.query('SELECT current_schema() AS schema');
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    const patches = {
      shorts_delivery_package_guard: [
        [
          "IF NOT content ? 'original' THEN",
          "IF NOT content ? 'original' AND NEW.source_identity::jsonb #>> '{generation,job}'=NEW.short_id THEN",
        ],
        [
          `IF NOT FOUND OR content->'cid' IS DISTINCT FROM canonical->'cid'
            OR content->'bytes' IS DISTINCT FROM canonical->'bytes'
            OR content->'original' IS DISTINCT FROM canonical->'original' THEN`,
          `IF NOT FOUND OR content->'bytes' IS DISTINCT FROM ${s}.shorts_delivery_source(canonical)->'bytes'
            OR content#>>'{original,sha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(canonical)->>'sha256'
            OR (canonical ? 'original' AND (content->'cid' IS DISTINCT FROM canonical->'cid'
              OR content->'original' IS DISTINCT FROM canonical->'original')) THEN`,
        ],
      ],
      shorts_delivery_selection_guard: [
        [
          "NOT FOUND OR NOT original ? 'original' OR original->>'publication'",
          "NOT FOUND OR original->>'publication'",
        ],
        [
          "original#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}'",
          `original#>>'{safety,sourceSha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->>'sha256'`,
        ],
        [
          `PERFORM ${s}.shorts_validate_original(original);`,
          `PERFORM ${s}.shorts_delivery_source(original);`,
        ],
        [
          "candidate#>>'{safety,sourceSha256}' IS DISTINCT FROM original#>>'{original,sha256}'",
          `candidate#>>'{safety,sourceSha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->>'sha256'`,
        ],
        [
          `candidate->'cid' IS DISTINCT FROM original->'cid' OR candidate->'bytes' IS DISTINCT FROM original->'bytes'
              OR candidate->'original' IS DISTINCT FROM original->'original'`,
          `candidate->'bytes' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->'bytes'
              OR candidate#>>'{original,sha256}' IS DISTINCT FROM ${s}.shorts_delivery_source(original)->>'sha256'
              OR (original ? 'original' AND (candidate->'cid' IS DISTINCT FROM original->'cid'
                OR candidate->'original' IS DISTINCT FROM original->'original'))`,
        ],
      ],
    };
    for (const [name, edits] of Object.entries(patches)) {
      const [{ definition }] = await db.query(
        'SELECT pg_get_functiondef($1::regprocedure) AS definition',
        [`${s}.${name}()`],
      );
      let sql = definition;
      for (const pair of reverse ? [...edits].reverse() : edits) {
        const [from, to] = reverse ? [pair[1], pair[0]] : pair;
        if (sql.split(from).length !== 2)
          throw new Error('Unexpected legacy selection predecessor');
        sql = sql.replace(from, () => to);
      }
      await db.query(sql);
    }
  }
  async up(db: QueryRunner): Promise<void> {
    await this.guards(db, false);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'LOCK TABLE shorts_content,shorts_delivery_packages,shorts_delivery_selections IN ACCESS EXCLUSIVE MODE',
    );
    const [{ used }] =
      await db.query(`SELECT EXISTS(SELECT FROM shorts_delivery_packages p JOIN shorts_content c
      ON c.network=p.network AND c.contract=p.contract AND c.id=p.short_id
      WHERE NOT c.body ? 'original' AND p.generation_job_id<>p.short_id) AS used`);
    if (used)
      throw new Error(
        'Preserve acknowledged legacy upgrade history before rollback',
      );
    await this.guards(db, true);
  }
}
