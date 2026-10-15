import { MigrationInterface, QueryRunner } from 'typeorm';

/** Capacity waits preserve the source and retry budget under the existing worker authority. */
export class ShortsWorkerBackpressure1791763222000 implements MigrationInterface {
  private async definitions(runner: QueryRunner, reverse: boolean) {
    const [{ schema }] = await runner.query(
      'SELECT current_schema() AS schema',
    );
    const s = `"${String(schema).replaceAll('"', '""')}"`;
    const defer = `IF action='defer' THEN
        IF payload - ARRAY['network','contract','sourceHash','id','fence','leaseToken'] <> '{}'::jsonb THEN
          RAISE EXCEPTION 'Invalid capacity deferral' USING ERRCODE='SH400';
        END IF;
        UPDATE ${s}.shorts_ingestion SET status='queued',attempts=greatest(attempts-1,0),
          lease_token=NULL,lease_principal=NULL,lease_until=NULL,
          error_code='capacity_wait',updated_at=clock_timestamp()
          WHERE network=binding.network AND contract=binding.contract AND id=job.id;
        RETURN 'true'::jsonb;
      END IF;
      `;
    const changes: [string, [string, string][]][] = [
      [
        'shorts_media_worker(text,jsonb)',
        [
          [
            "IF action='verify' THEN RETURN '{}'::jsonb; END IF;",
            "IF action='verify' THEN RETURN '{\"capacityDeferVersion\":1}'::jsonb; END IF;",
          ],
          [
            "AND attempts<3 AND (status='queued' OR (status='processing' AND lease_until<=clock_timestamp()))",
            "AND attempts<3 AND ((status='queued' AND (error_code IS DISTINCT FROM 'capacity_wait' OR updated_at<=clock_timestamp()-interval '5 seconds')) OR (status='processing' AND lease_until<=clock_timestamp()))",
          ],
          [
            "IF action NOT IN ('heartbeat','fail','complete') OR action IS NULL",
            "IF action NOT IN ('heartbeat','fail','complete','defer') OR action IS NULL",
          ],
          [
            "IF action IN ('heartbeat','fail') THEN RETURN 'false'::jsonb; END IF;",
            "IF action IN ('heartbeat','fail','defer') THEN RETURN 'false'::jsonb; END IF;",
          ],
          ["IF action='fail' THEN", `${defer}IF action='fail' THEN`],
        ],
      ],
      [
        'shorts_processing_capacity()',
        [
          [
            "IF NEW.status<>'processing' THEN RETURN NEW; END IF;",
            "IF NEW.status<>'processing' THEN RETURN NEW; END IF;\n        IF TG_OP='UPDATE' AND OLD.status='queued' AND OLD.error_code='capacity_wait' AND OLD.updated_at>clock_timestamp()-interval '5 seconds' THEN RETURN NULL; END IF;",
          ],
        ],
      ],
    ];
    // Preserve each function's identity, grants, definer and pinned search_path.
    // Refuse an unexpected predecessor instead of silently dropping a guard.
    const definitions: string[] = [];
    for (const [name, replacements] of changes) {
      const [{ definition }] = await runner.query(
        'SELECT pg_get_functiondef($1::regprocedure) AS definition',
        [`${s}.${name}`],
      );
      let sql = String(definition);
      for (const pair of replacements) {
        const [from, to] = reverse ? [pair[1], pair[0]] : pair;
        if (sql.split(from).length !== 2)
          throw new Error('Unexpected Shorts worker migration predecessor');
        sql = sql.replace(from, to);
      }
      definitions.push(sql);
    }
    for (const sql of definitions) await runner.query(sql);
  }
  async up(runner: QueryRunner): Promise<void> {
    await this.definitions(runner, false);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('LOCK TABLE shorts_ingestion IN EXCLUSIVE MODE');
    const [{ waiting }] =
      await runner.query(`SELECT EXISTS(SELECT FROM shorts_ingestion
      WHERE status='processing' OR (status='queued' AND error_code='capacity_wait')) AS waiting`);
    if (waiting)
      throw new Error(
        'Drain processing and deferred Shorts jobs before rollback',
      );
    await this.definitions(runner, true);
  }
}
