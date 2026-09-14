import 'dotenv/config';
import { Contract } from '@aeternity/aepp-sdk';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { SocialGraphEdge1718900000024 } from '@/migrations/1718900000024-SocialGraphEdge';
import { SocialGraphCounts1718900000026 } from '@/migrations/1718900000026-SocialGraphCounts';
import { SocialGraphEdge } from './entities/social-graph-edge.entity';
import { SocialGraphCount } from './entities/social-graph-count.entity';
import { SocialGraphPluginSyncService } from './social-graph-plugin-sync.service';
import { SocialGraphService } from './social-graph.service';
import { loadSocialContractAci } from './social-graph-aci';
import { SyncDirectionEnum } from '../plugin.interface';

/**
 * Proof for the real bug: MDW serialises event `topics` as decimal strings, and
 * aepp-sdk's `$decodeEvents` matches them against the BigInt event-name hash with
 * strict equality — so with `omitUnknown: true` every event was silently dropped
 * and no edge was ever written. The fix normalises topics to BigInt in
 * `decodeLogs`. Driven with the exact mainnet identifiers and the real on-chain
 * log for `th_23vad…Fi6`.
 */
const CONTRACT = 'ct_tC6G9MzysAvny8RBdq56oG3emgbUYEZhmfbaC3irfA8bbBJRS';
const FROM = 'ak_wqP6GiNVJeE6XyRGMjZE6Cq8rV6RRPbrVBr15TxB9GAFdqcph';
const TO = 'ak_LF4siZQxMqjGBAcHS2MMacMYgYjHjRh4HkDwqF3sA59oLfcMA';
const TX_HASH = 'th_23vadMrrvjpvN3D2bdKk9kFmom5F4FPMPRb6oqquDYLFko7Fi6';
const HEIGHT = 1352517;

// The real mainnet log for th_23vad…Fi6, topics exactly as MDW serves them:
// decimal strings. This is the shape that decoded to zero events before the fix.
const MAINNET_FOLLOW_LOG = [
  {
    address: CONTRACT,
    data: 'cb_Xfbg4g==',
    topics: [
      '105979794572335484953012995442908340357737372754312854154575839712858115201185',
      '56316410991042537755060616138119971247511670139290349113019571963818210418985',
      '19762688511630024962944591000186071650780592299797255153211712050644163348338',
    ],
  },
];

// A real decoder built from the committed ACI. `$decodeEvents` needs only the
// ACI; the stub onNode just satisfies initialize's address check offline.
async function realContract(): Promise<any> {
  const onNode: any = { getContract: async () => ({ active: true }) };
  return Contract.initialize({
    aci: loadSocialContractAci(),
    address: CONTRACT,
    onNode,
  } as any);
}

const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

describe('social-graph decodeLogs — MDW decimal-string topics (no DB)', () => {
  it('decodes the real Followed log after normalising topics; raw string topics decode to nothing', async () => {
    const contract = await realContract();

    // The bug, pinned: topics as MDW serves them (decimal strings) match no
    // event definition, so decoding yields nothing.
    expect(
      contract.$decodeEvents(MAINNET_FOLLOW_LOG, { omitUnknown: true }),
    ).toEqual([]);

    // The fix: decodeLogs normalises topics to BigInt before $decodeEvents.
    const service = new SocialGraphPluginSyncService({} as any, {} as any);
    jest.spyOn(service as any, 'getContract').mockResolvedValue(contract);
    const events = await service.decodeLogs({
      hash: TX_HASH,
      raw: { log: MAINNET_FOLLOW_LOG },
    } as any);
    expect(events).toEqual([{ name: 'Followed', args: [FROM, TO] }]);
  });
});

d('social-graph ingestion → read (DB, decodes the real mainnet log)', () => {
  let db: IsolatedDb;
  let syncService: SocialGraphPluginSyncService;
  let readService: SocialGraphService;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [SocialGraphEdge, SocialGraphCount],
      migrations: [
        SocialGraphEdge1718900000024,
        SocialGraphCounts1718900000026,
      ],
    });
    await db.dataSource.runMigrations();
    const edgeRepo = db.dataSource.getRepository(SocialGraphEdge);
    syncService = new SocialGraphPluginSyncService({} as any, edgeRepo);
    jest
      .spyOn(syncService as any, 'getContract')
      .mockImplementation(() => realContract());
    // contractService is only used by precheck(); the read paths under test
    // never touch it.
    readService = new SocialGraphService(edgeRepo, {} as any);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('processes the raw log through decodeLogs and serves the follower count + relationship', async () => {
    // No pre-decoded logs: processTransaction must call decodeLogs itself, so
    // this exercises the exact step that was broken — not a hand-fed event.
    const tx = {
      hash: TX_HASH,
      block_height: HEIGHT,
      raw: { log: MAINNET_FOLLOW_LOG },
    } as any;
    await syncService.processTransaction(tx, SyncDirectionEnum.Backward);

    // The two reads the bug showed empty now report the edge.
    expect(await readService.getFollowersCount(TO)).toBe(1);
    expect(await readService.getFollowingCount(FROM)).toBe(1);
    const relationship = await readService.getRelationship(FROM, TO);
    expect(relationship.a_follows_b).toBe(true);
    expect(relationship.b_follows_a).toBe(false);

    // The edge is tagged with the exact tx that was missed.
    const [edge] = await db.dataSource.query(
      `SELECT tx_hash, height FROM social_graph_edges
       WHERE from_address = $1 AND to_address = $2 AND kind = 'follow'`,
      [FROM, TO],
    );
    expect(edge).toMatchObject({ tx_hash: TX_HASH, height: HEIGHT });

    // Idempotent replay: re-processing the same tx does not double-count.
    await syncService.processTransaction(tx, SyncDirectionEnum.Backward);
    expect(await readService.getFollowersCount(TO)).toBe(1);
  });
});
