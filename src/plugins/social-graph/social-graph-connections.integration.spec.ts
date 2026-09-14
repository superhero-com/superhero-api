import 'dotenv/config';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Account } from '@/account/entities/account.entity';
import { ProfileCache } from '@/profile/entities/profile-cache.entity';
import { SocialGraphEdge } from './entities/social-graph-edge.entity';
import { SocialGraphService } from './social-graph.service';
import { SocialGraphContractService } from './social-graph-contract.service';

/**
 * DB-backed proof of the followers/following list read: direction, newest-first
 * order, keyset pagination (no overlap, no gap, terminates), and search over the
 * counterparty's address / chain name / cached profile name. The query builds
 * joins to `accounts` and `profile_cache`, so it can only be exercised against a
 * real Postgres. Requires the local test DB (`DB_HOST`); auto-skips otherwise.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const OWNER = 'ak_owner';

function makeService(edgeRepo: any): SocialGraphService {
  const contractService = {
    getConfig: () => ({
      max_following: 10000,
      max_blocked: 10000,
      follow_cooldown: 0,
      contract_address: 'ct_test',
    }),
  } as unknown as SocialGraphContractService;
  return new SocialGraphService(edgeRepo, contractService);
}

d('social-graph connection lists (search + pagination)', () => {
  let db: IsolatedDb;
  let service: SocialGraphService;

  // OWNER follows f0..f14 and is followed by g0..g4. followers are inserted in
  // ascending index order, so the edge ids ascend with the index and a
  // newest-first (id DESC) page starts at the highest index.
  const following = Array.from({ length: 15 }, (_, i) => `ak_follow_${i}`);
  const followers = Array.from({ length: 5 }, (_, i) => `ak_er_${i}`);

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [SocialGraphEdge, Account, ProfileCache],
      migrations: [],
    });
    await db.dataSource.synchronize();

    for (const to of following) {
      await db.dataSource.query(
        `INSERT INTO social_graph_edges (from_address, to_address, kind, height, tx_hash)
         VALUES ($1, $2, 'follow', 1, 'th_seed')`,
        [OWNER, to],
      );
    }
    for (const from of followers) {
      await db.dataSource.query(
        `INSERT INTO social_graph_edges (from_address, to_address, kind, height, tx_hash)
         VALUES ($1, $2, 'follow', 1, 'th_seed')`,
        [from, OWNER],
      );
    }
    // A block edge that must never appear in a follow list.
    await db.dataSource.query(
      `INSERT INTO social_graph_edges (from_address, to_address, kind, height, tx_hash)
       VALUES ($1, 'ak_blocked', 'block', 1, 'th_seed')`,
      [OWNER],
    );

    // Search fixtures: one followed account has a chain name, one a cached
    // profile name; the rest are address-only.
    await db.dataSource.query(
      `INSERT INTO accounts (address, chain_name) VALUES ('ak_follow_3', 'alice.chain')`,
    );
    await db.dataSource.query(
      `INSERT INTO profile_cache (address, public_name) VALUES ('ak_follow_7', 'Bob The Builder')`,
    );

    service = makeService(db.dataSource.getRepository(SocialGraphEdge));
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('lists followers, not following, and excludes block edges', async () => {
    const page = await service.listConnections({
      address: OWNER,
      direction: 'followers',
      limit: 100,
    });
    expect(page.addresses.sort()).toEqual([...followers].sort());
    expect(page.nextCursor).toBeNull();
    expect(page.addresses).not.toContain('ak_blocked');
  });

  it('lists following, newest edge first', async () => {
    const page = await service.listConnections({
      address: OWNER,
      direction: 'following',
      limit: 100,
    });
    expect(page.addresses).toEqual([...following].reverse());
    expect(page.nextCursor).toBeNull();
  });

  it('keyset-paginates following without overlap or gap and terminates', async () => {
    const seen: string[] = [];
    let cursor: number | undefined;
    let pages = 0;
    do {
      const page = await service.listConnections({
        address: OWNER,
        direction: 'following',
        limit: 6,
        cursor,
      });
      expect(page.addresses.length).toBeLessThanOrEqual(6);
      seen.push(...page.addresses);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against a non-terminating cursor
    } while (cursor !== undefined);

    expect(pages).toBe(3); // 15 rows / 6 per page
    expect(new Set(seen).size).toBe(following.length);
    expect(seen).toEqual([...following].reverse());
  });

  it('searches following by chain name', async () => {
    const page = await service.listConnections({
      address: OWNER,
      direction: 'following',
      search: 'alice',
      limit: 100,
    });
    expect(page.addresses).toEqual(['ak_follow_3']);
  });

  it('searches following by cached profile name (case-insensitive)', async () => {
    const page = await service.listConnections({
      address: OWNER,
      direction: 'following',
      search: 'bob the',
      limit: 100,
    });
    expect(page.addresses).toEqual(['ak_follow_7']);
  });

  it('searches following by address substring', async () => {
    const page = await service.listConnections({
      address: OWNER,
      direction: 'following',
      search: 'follow_1',
      limit: 100,
    });
    // ak_follow_1 and ak_follow_10..14 all match the substring.
    expect(page.addresses.sort()).toEqual(
      [
        'ak_follow_1',
        'ak_follow_10',
        'ak_follow_11',
        'ak_follow_12',
        'ak_follow_13',
        'ak_follow_14',
      ].sort(),
    );
  });

  it('returns an empty page for an address with no edges', async () => {
    const page = await service.listConnections({
      address: 'ak_nobody',
      direction: 'followers',
      limit: 100,
    });
    expect(page.addresses).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
