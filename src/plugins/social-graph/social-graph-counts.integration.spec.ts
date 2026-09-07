import 'dotenv/config';
import { QueryRunner } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { SocialGraphEdge1718900000024 } from '@/migrations/1718900000024-SocialGraphEdge';
import { SocialGraphCounts1718900000026 } from '@/migrations/1718900000026-SocialGraphCounts';
import { SocialGraphEdge } from './entities/social-graph-edge.entity';
import { SocialGraphCount } from './entities/social-graph-count.entity';
import { SocialGraphPluginSyncService } from './social-graph-plugin-sync.service';
import { SyncDirectionEnum } from '../plugin.interface';

/**
 * DB-backed proof that `social_graph_counts` is a pure function of
 * `social_graph_edges`: the counter equals `COUNT(*)` after replay, a no-op
 * unfollow, a reorg bulk-delete and a full re-apply, and can never go negative.
 * Requires the local Postgres (`DB_HOST`); auto-skips otherwise so unit-only runs
 * stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const A = 'ak_alice';
const B = 'ak_bob';
const C = 'ak_carol';

interface Event {
  name: string;
  args: string[];
}

function tx(events: Event[], hash = 'th_x', height = 100): any {
  return {
    hash,
    block_height: height,
    logs: { 'social-graph': { data: events } },
  };
}

async function edgeCount(
  db: IsolatedDb,
  address: string,
  direction: 'followers' | 'following',
): Promise<number> {
  const column = direction === 'followers' ? 'to_address' : 'from_address';
  const rows = await db.dataSource.query(
    `SELECT COUNT(*)::int AS c FROM social_graph_edges WHERE ${column} = $1 AND kind = 'follow'`,
    [address],
  );
  return rows[0].c;
}

async function storedCounts(
  db: IsolatedDb,
  address: string,
): Promise<{ followers_count: number; following_count: number } | null> {
  const rows = await db.dataSource.query(
    `SELECT followers_count, following_count FROM social_graph_counts WHERE address = $1`,
    [address],
  );
  return rows[0] ?? null;
}

// The stored row (0 when absent) must equal the edge COUNT(*) for both sides.
async function expectCounterMatchesEdges(
  db: IsolatedDb,
  address: string,
): Promise<void> {
  const stored = await storedCounts(db, address);
  const followers = await edgeCount(db, address, 'followers');
  const following = await edgeCount(db, address, 'following');
  expect(stored?.followers_count ?? 0).toBe(followers);
  expect(stored?.following_count ?? 0).toBe(following);
  expect(stored?.followers_count ?? 0).toBeGreaterThanOrEqual(0);
  expect(stored?.following_count ?? 0).toBeGreaterThanOrEqual(0);
}

d('social-graph counts (migration + idempotence)', () => {
  describe('migration backfill and reversibility', () => {
    let db: IsolatedDb;

    beforeAll(async () => {
      // Build only the edge table via its migration, seed edges, then run the
      // counts migration so the backfill has data to aggregate.
      db = await createIsolatedDatabase({
        entities: [SocialGraphEdge, SocialGraphCount],
        migrations: [SocialGraphEdge1718900000024],
      });
      await db.dataSource.runMigrations();
      const seed = [
        [A, B, 'follow'],
        [C, B, 'follow'],
        [B, A, 'follow'],
        [A, C, 'block'], // block edges never count toward follow totals
      ];
      for (const [from, to, kind] of seed) {
        await db.dataSource.query(
          `INSERT INTO social_graph_edges (from_address, to_address, kind, height, tx_hash)
           VALUES ($1, $2, $3, 1, 'th_seed')`,
          [from, to, kind],
        );
      }
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    it('up() backfills counts from the edge table', async () => {
      const qr: QueryRunner = db.dataSource.createQueryRunner();
      try {
        await new SocialGraphCounts1718900000026().up(qr);
      } finally {
        await qr.release();
      }
      // B is followed by A and C, and follows A.
      expect(await storedCounts(db, B)).toEqual({
        followers_count: 2,
        following_count: 1,
      });
      // A follows B, is followed by B; the block edge is ignored.
      expect(await storedCounts(db, A)).toEqual({
        followers_count: 1,
        following_count: 1,
      });
      // C follows B, is followed by nobody.
      expect(await storedCounts(db, C)).toEqual({
        followers_count: 0,
        following_count: 1,
      });
    });

    it('rejects a negative counter by construction (CHECK constraint)', async () => {
      await expect(
        db.dataSource.query(
          `INSERT INTO social_graph_counts (address, followers_count, following_count)
           VALUES ('ak_neg', -1, 0)`,
        ),
      ).rejects.toThrow();
    });

    it('down() drops the table', async () => {
      const qr: QueryRunner = db.dataSource.createQueryRunner();
      try {
        await new SocialGraphCounts1718900000026().down(qr);
        const exists = await qr.query(
          `SELECT to_regclass('social_graph_counts') AS t`,
        );
        expect(exists[0].t).toBeNull();
      } finally {
        await qr.release();
      }
    });
  });

  describe('sync-service idempotence', () => {
    let db: IsolatedDb;
    let service: SocialGraphPluginSyncService;

    beforeAll(async () => {
      db = await createIsolatedDatabase({
        entities: [SocialGraphEdge, SocialGraphCount],
        migrations: [
          SocialGraphEdge1718900000024,
          SocialGraphCounts1718900000026,
        ],
      });
      await db.dataSource.runMigrations();
      service = new SocialGraphPluginSyncService(
        {} as any,
        db.dataSource.getRepository(SocialGraphEdge),
      );
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    beforeEach(async () => {
      await db.dataSource.query(`DELETE FROM social_graph_edges`);
      await db.dataSource.query(`DELETE FROM social_graph_counts`);
    });

    it('applying Followed twice leaves the counter at the edge COUNT(*)', async () => {
      await service.processTransaction(
        tx([{ name: 'Followed', args: [A, B] }]),
        SyncDirectionEnum.Backward,
      );
      await service.processTransaction(
        tx([{ name: 'Followed', args: [A, B] }]),
        SyncDirectionEnum.Backward,
      );
      expect(await storedCounts(db, A)).toMatchObject({ following_count: 1 });
      expect(await storedCounts(db, B)).toMatchObject({ followers_count: 1 });
      await expectCounterMatchesEdges(db, A);
      await expectCounterMatchesEdges(db, B);
    });

    it('Unfollowed for a non-existent edge cannot drive the counter negative', async () => {
      await service.processTransaction(
        tx([{ name: 'Unfollowed', args: [A, B] }]),
        SyncDirectionEnum.Backward,
      );
      expect(await storedCounts(db, A)).toMatchObject({ following_count: 0 });
      expect(await storedCounts(db, B)).toMatchObject({ followers_count: 0 });
      await expectCounterMatchesEdges(db, A);
      await expectCounterMatchesEdges(db, B);
    });

    it('removeEdgesForTxs recomputes every affected address', async () => {
      await service.processTransaction(
        tx([{ name: 'Followed', args: [A, B] }], 'th_1'),
        SyncDirectionEnum.Backward,
      );
      await service.processTransaction(
        tx([{ name: 'Followed', args: [C, B] }], 'th_2'),
        SyncDirectionEnum.Backward,
      );
      expect(await storedCounts(db, B)).toMatchObject({ followers_count: 2 });

      await service.removeEdgesForTxs(['th_1']);

      expect(await storedCounts(db, B)).toMatchObject({ followers_count: 1 });
      await expectCounterMatchesEdges(db, A);
      await expectCounterMatchesEdges(db, B);
      await expectCounterMatchesEdges(db, C);
    });

    it('replaying the full event stream from scratch converges on the same counters', async () => {
      const stream: Event[] = [
        { name: 'Followed', args: [A, B] },
        { name: 'Followed', args: [C, B] },
        { name: 'Followed', args: [B, A] },
        { name: 'Unfollowed', args: [C, B] },
        { name: 'Blocked', args: [A, C] },
      ];
      const apply = async () => {
        for (const [i, event] of stream.entries()) {
          await service.processTransaction(
            tx([event], `th_${i}`),
            SyncDirectionEnum.Backward,
          );
        }
      };

      await apply();
      const first = await Promise.all([
        storedCounts(db, A),
        storedCounts(db, B),
        storedCounts(db, C),
      ]);

      // Replay from a clean counts table: the derived value must not depend on
      // the prior counter state, only on the resulting edge table.
      await db.dataSource.query(`DELETE FROM social_graph_counts`);
      await apply();
      const second = await Promise.all([
        storedCounts(db, A),
        storedCounts(db, B),
        storedCounts(db, C),
      ]);

      expect(second).toEqual(first);
      for (const address of [A, B, C]) {
        await expectCounterMatchesEdges(db, address);
      }
    });
  });
});
