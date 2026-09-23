import { DataSource } from 'typeorm';
import { statfsSync, writeFileSync } from 'fs';
import {
  findPostgresBinDir,
  startPostgres,
  PostgresHandle,
} from '@/test/reward-e2e/postgres';
import { SocialGraphV2Projection1718900000035 } from '@/migrations/1718900000035-SocialGraphV2Projection';
import { SocialGraphV2ProjectionService } from './social-graph-v2-projection.service';
import { SocialGraphV2QueryService } from './social-graph-v2-query.service';

const enabled = process.env.SOCIAL_GRAPH_V2_SCALE_TEST === 'true';
(enabled ? describe : describe.skip)(
  'V2 million-row PostgreSQL qualification',
  () => {
    let pg: PostgresHandle, db: DataSource;
    const scope = { network: 'ae_dev', contract: 'ct_scale', generation: '1' };
    beforeAll(async () => {
      const disk = statfsSync('/tmp');
      if (disk.bavail * disk.bsize < 5 * 1024 ** 3)
        throw new Error('5 GiB free-space guard');
      const bin = findPostgresBinDir();
      if (!bin) throw new Error('PostgreSQL not installed');
      pg = await startPostgres(bin);
      db = new DataSource({ type: 'postgres', url: pg.url });
      await db.initialize();
      const runner = db.createQueryRunner();
      try {
        await new SocialGraphV2Projection1718900000035().up(runner);
      } finally {
        await runner.release();
      }
    }, 30000);
    afterAll(async () => {
      await db?.destroy();
      pg?.stop();
    });
    it('uses bounded index scans and constant-size deltas at one million incoming edges', async () => {
      await db.query(
        "INSERT INTO social_graph_v2_scopes(network,contract,generation,state) VALUES('ae_dev','ct_scale',1,'ready')",
      );
      const started = Date.now();
      await db.query(`INSERT INTO social_graph_v2_edges(network,contract,generation,from_address,to_address,kind)
      SELECT 'ae_dev','ct_scale',1,'ak_a'||translate(n::text,'0123456789','abcdefghij'),'ak_b','follow' FROM generate_series(1,1000000) n`);
      await db.query(
        "INSERT INTO social_graph_v2_counts(network,contract,generation,address,followers) VALUES('ae_dev','ct_scale',1,'ak_b',1000000)",
      );
      await db.query('ANALYZE social_graph_v2_edges');
      const seededMs = Date.now() - started;
      const explain =
        await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,from_address FROM social_graph_v2_edges
      WHERE network='ae_dev' AND contract='ct_scale' AND generation=1 AND to_address='ak_b' AND kind='follow'
      AND id<500000 ORDER BY id DESC LIMIT 101`);
      const plan = explain[0]['QUERY PLAN'][0];
      const scans: any[] = [];
      const visit = (p: any) => {
        if (p['Node Type'].includes('Scan')) scans.push(p);
        for (const child of p.Plans ?? []) visit(child);
      };
      visit(plan.Plan);
      expect(scans.some((p) => p['Node Type'] === 'Index Scan')).toBe(true);
      expect(scans.some((p) => p['Node Type'] === 'Seq Scan')).toBe(false);
      expect(plan.Plan['Actual Rows']).toBe(101);
      expect(
        scans.reduce(
          (n, p) => n + (p['Rows Removed by Filter'] ?? 0) + p['Actual Rows'],
          0,
        ),
      ).toBeLessThanOrEqual(1024);
      const queries = new SocialGraphV2QueryService(db);
      expect((await queries.counts(scope, 'ak_b')).followers).toBe('1000000');
      const first = await queries.connections(scope, 'ak_b', 'followers', 100);
      expect(first.addresses).toHaveLength(100);
      const second = await queries.connections(
        scope,
        'ak_b',
        'followers',
        100,
        first.next_cursor!,
      );
      expect(new Set([...first.addresses, ...second.addresses]).size).toBe(200);
      const projection = new SocialGraphV2ProjectionService(db),
        writesAt = Date.now();
      await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          projection.applyEvent(
            scope,
            { transaction: `th_${index}`, index: 0, height: '100' },
            [
              {
                from: 'ak_new' + String.fromCharCode(97 + index),
                to: 'ak_b',
                kind: 'follow',
                present: true,
              },
            ],
          ),
        ),
      );
      const concurrentWritesMs = Date.now() - writesAt;
      expect((await queries.counts(scope, 'ak_b')).followers).toBe('1000016');
      writeFileSync(
        'docs/evidence/social-graph-v2-million-postgres.json',
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            dataset: { incomingEdges: 1000000 },
            seededMs,
            concurrentWrites: 16,
            concurrentWritesMs,
            queryPlan: plan,
            limitations:
              'Local disposable PostgreSQL; no chain-throughput or production-hardware claim. Source-account counts outside touched test accounts are not seeded.',
          },
          null,
          2,
        ) + '\n',
      );
    }, 180000);
  },
);
