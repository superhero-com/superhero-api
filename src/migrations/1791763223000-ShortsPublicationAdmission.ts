import { MigrationInterface, QueryRunner } from 'typeorm';

/** Read-only preparation admission within the existing scoped publisher boundary. */
export class ShortsPublicationAdmission1791763223000 implements MigrationInterface {
  private async definition(runner: QueryRunner, reverse: boolean) {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    const changes: [string, string][] = [
      [
        "('verify','enqueue','status','claim','persist','authorize','renew','release','settle','reconcile')",
        "('verify','enqueue','status','capacity','claim','persist','authorize','renew','release','settle','reconcile')",
      ],
      [
        "jsonb_build_object('kind',principal.kind,'operator',binding.operator,'policy',account.policy)",
        "jsonb_build_object('kind',principal.kind,'operator',binding.operator,'policy',account.policy,'preparationCapacityVersion',1)",
      ],
      [
        "principal.kind='api' AND action NOT IN ('enqueue','status')",
        "principal.kind='api' AND action NOT IN ('enqueue','status','capacity')",
      ],
      [
        "IF job.intent IS DISTINCT FROM intent THEN RAISE EXCEPTION 'Immutable publication identity' USING ERRCODE='SH409'; END IF;",
        "IF job.intent IS DISTINCT FROM intent THEN RAISE EXCEPTION 'Immutable publication identity' USING ERRCODE='SH409'; END IF;\n          IF action='capacity' THEN RETURN '{\"ready\":false}'::jsonb; END IF;",
      ],
      [
        "IF account.paused THEN RAISE EXCEPTION 'Publication paused' USING ERRCODE='SH503'; END IF;",
        "IF account.paused THEN\n          IF action='capacity' THEN RETURN '{\"ready\":false}'::jsonb; END IF;\n          RAISE EXCEPTION 'Publication paused' USING ERRCODE='SH503';\n        END IF;",
      ],
      [
        "RAISE EXCEPTION 'Publication queue full' USING ERRCODE='SH503';",
        "IF action='capacity' THEN RETURN '{\"ready\":false}'::jsonb; END IF;\n          RAISE EXCEPTION 'Publication queue full' USING ERRCODE='SH503';",
      ],
      [
        `INSERT INTO ${s}.shorts_publication_jobs(network,contract,id,operator,creator,intent)`,
        `IF action='capacity' THEN RETURN '{"ready":true}'::jsonb; END IF;
        INSERT INTO ${s}.shorts_publication_jobs(network,contract,id,operator,creator,intent)`,
      ],
    ];
    const [{ definition }] = await runner.query(
      'SELECT pg_get_functiondef($1::regprocedure) AS definition',
      [`${s}.shorts_publication(text,jsonb)`],
    );
    let sql = String(definition);
    for (const pair of changes) {
      const [from, to] = reverse ? [pair[1], pair[0]] : pair;
      if (sql.split(from).length !== 2)
        throw new Error('Unexpected Shorts publication migration predecessor');
      sql = sql.replace(from, to);
    }
    // CREATE OR REPLACE preserves identity, definer, grants and fixed search_path.
    // Both directions leave every journal row, signed byte and reservation intact.
    await runner.query(sql);
  }
  async up(runner: QueryRunner): Promise<void> {
    await this.definition(runner, false);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'LOCK TABLE shorts_publishing_accounts IN EXCLUSIVE MODE',
    );
    await this.definition(runner, true);
  }
}
