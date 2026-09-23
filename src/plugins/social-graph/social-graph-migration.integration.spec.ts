import { DataSource } from 'typeorm';
import {
  findPostgresBinDir,
  startPostgres,
  PostgresHandle,
} from '@/test/reward-e2e/postgres';
import { SocialGraphEdge1718900000024 } from '@/migrations/1718900000024-SocialGraphEdge';
import { SocialGraphCounts1718900000026 } from '@/migrations/1718900000026-SocialGraphCounts';
import { SocialGraphProjection1718900000035 } from '@/migrations/1718900000035-SocialGraphProjection';
import { SocialGraphQueryService } from './social-graph-query.service';

const bin = findPostgresBinDir();
(bin ? describe : describe.skip)('Social graph projection upgrade', () => {
  let pg: PostgresHandle, db: DataSource;
  beforeAll(async () => {
    pg = await startPostgres(bin!);
    db = new DataSource({ type: 'postgres', url: pg.url });
    await db.initialize();
  }, 30000);
  afterAll(async () => {
    await db?.destroy();
    pg?.stop();
  });

  it('preserves old replicas and their data through upgrade/rollback without mixing projections', async () => {
    const q = db.createQueryRunner();
    try {
      await new SocialGraphEdge1718900000024().up(q);
      await q.query(
        "INSERT INTO social_graph_edges(from_address,to_address,kind,height,tx_hash) VALUES('ak_old','ak_oldtarget','follow',1,'th_old')",
      );
      await new SocialGraphCounts1718900000026().up(q);
      const migration = new SocialGraphProjection1718900000035();
      await migration.up(q);
      const queries = new SocialGraphQueryService(db);
      await expect(queries.ready('ae_dev', 'ct_selected')).rejects.toThrow(
        'not ready',
      );
      expect(
        await q.query('SELECT from_address FROM social_graph_edges'),
      ).toEqual([{ from_address: 'ak_old' }]);
      expect(
        await q.query('SELECT * FROM social_graph_projection_edges'),
      ).toEqual([]);
      // Existing replicas can still issue their original reads/writes during deployment.
      await q.query(
        "INSERT INTO social_graph_edges(from_address,to_address,kind,height,tx_hash) VALUES('ak_second','ak_oldtarget','follow',2,'th_second')",
      );
      await q.query(
        "INSERT INTO social_graph_projection_edges(network,contract,generation,from_address,to_address,kind) VALUES('ae_dev','ct_selected',1,'ak_new','ak_target','follow')",
      );
      expect(
        (await q.query('SELECT id FROM social_graph_projection_edges'))[0].id,
      ).toBeDefined();
      expect(
        (
          await q.query('SELECT count(*)::int AS count FROM social_graph_edges')
        )[0].count,
      ).toBe(2);
      await migration.down(q);
      expect(
        (
          await q.query('SELECT count(*)::int AS count FROM social_graph_edges')
        )[0].count,
      ).toBe(2);
      expect(
        await q.query(
          "SELECT followers_count FROM social_graph_counts WHERE address='ak_oldtarget'",
        ),
      ).toEqual([{ followers_count: 1 }]);
      await migration.up(q);
      expect(
        await q.query('SELECT * FROM social_graph_projection_edges'),
      ).toEqual([]);
    } finally {
      await q.release();
    }
  });

  it('bounds searches to one page and binds their continuation to the selected graph and query', async () => {
    await db.query(
      'CREATE TABLE accounts(address text PRIMARY KEY,chain_name text)',
    );
    await db.query(
      'CREATE TABLE profile_cache(address text PRIMARY KEY, public_name text, username text, fullname text)',
    );
    await db.query(
      "INSERT INTO social_graph_projection_scopes(network,contract,generation,state) VALUES('ae_dev','ct_selected',1,'ready')",
    );
    for (const address of ['ak_match', 'ak_empty', 'ak_missing'])
      await db.query(
        "INSERT INTO social_graph_projection_edges(network,contract,generation,from_address,to_address,kind) VALUES('ae_dev','ct_selected',1,$1,'ak_target','follow')",
        [address],
      );
    await db.query(
      "INSERT INTO profile_cache(address,fullname) VALUES('ak_match','Alice')",
    );
    const queries = new SocialGraphQueryService(db);
    const scope = await queries.ready('ae_dev', 'ct_selected');
    const first = await queries.connections(
      scope,
      'ak_target',
      'followers',
      2,
      undefined,
      'Alice',
    );
    expect(first.addresses).toEqual([]);
    expect(first.next_cursor).toBeTruthy();
    await expect(
      queries.connections(
        scope,
        'ak_target',
        'followers',
        2,
        first.next_cursor!,
        'Bob',
      ),
    ).rejects.toThrow('cursor');
    const last = await queries.connections(
      scope,
      'ak_target',
      'followers',
      2,
      first.next_cursor!,
      'Alice',
    );
    expect(last.addresses).toEqual(['ak_match']);
    expect(last.next_cursor).toBeNull();
    await expect(
      queries.connections(
        scope,
        'ak_target',
        'followers',
        2,
        undefined,
        'a'.repeat(101),
      ),
    ).rejects.toThrow('100');
    await expect(
      queries.connections(scope, 'ak_target', 'followers', 101),
    ).rejects.toThrow('Invalid page');
    await expect(
      queries.connections(
        scope,
        'ak_target',
        'following',
        2,
        first.next_cursor!,
        'Alice',
      ),
    ).rejects.toThrow('cursor');
  });
});
