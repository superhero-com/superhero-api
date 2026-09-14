import 'dotenv/config';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { SocialGraphEdge1718900000024 } from '@/migrations/1718900000024-SocialGraphEdge';
import { SocialGraphCounts1718900000026 } from '@/migrations/1718900000026-SocialGraphCounts';
import { SocialGraphEdge } from './entities/social-graph-edge.entity';
import { SocialGraphCount } from './entities/social-graph-count.entity';
import { SocialGraphPluginSyncService } from './social-graph-plugin-sync.service';
import { SocialGraphService } from './social-graph.service';
import { SyncDirectionEnum } from '../plugin.interface';

/**
 * End-to-end proof for the tip-ingestion fix, driven against the real Postgres
 * with the exact mainnet identifiers from the bug report:
 *
 *   1. Live path — a live/websocket-shaped ContractCallTx to the configured
 *      contract WITH NO decoded `function` (only contract_id / call_data) is
 *      relevant, so it is no longer dropped before the DB.
 *   2. Replay path — processing the follow that `th_23vad…Fi6` carried, exactly
 *      as the backfill would after decode, writes the follow edge (tagged with
 *      that tx hash and height 1352517).
 *   3. Read path — after processing, the follower count and the relationship
 *      read served to the API reflect the edge.
 *
 * Requires the local Postgres (`DB_HOST`); auto-skips otherwise.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const CONTRACT = 'ct_tC6G9MzysAvny8RBdq56oG3emgbUYEZhmfbaC3irfA8bbBJRS';
const FROM = 'ak_wqP6GiNVJeE6XyRGMjZE6Cq8rV6RRPbrVBr15TxB9GAFdqcph';
const TO = 'ak_LF4siZQxMqjGBAcHS2MMacMYgYjHjRh4HkDwqF3sA59oLfcMA';
const TX_HASH = 'th_23vadMrrvjpvN3D2bdKk9kFmom5F4FPMPRb6oqquDYLFko7Fi6';
const HEIGHT = 1352517;

describe('SocialGraphPlugin relevance filter — live payload (no DB)', () => {
  const KEY = 'SOCIAL_GRAPH_CONTRACT_ADDRESS';
  const original = process.env[KEY];

  afterAll(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  it('accepts a live ContractCallTx with contract_id/call_data but no function', () => {
    process.env[KEY] = CONTRACT;
    let SocialGraphPlugin: any;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      SocialGraphPlugin = require('./social-graph.plugin').SocialGraphPlugin;
    });
    const predicate = new SocialGraphPlugin(
      undefined as any,
      undefined as any,
      undefined as any,
    ).filters()[0].predicate;

    // Shaped like live-indexer's convertToMdwTx output for the follow tx:
    // the websocket payload has no decoded `function`.
    const liveTx = {
      hash: TX_HASH,
      type: 'ContractCallTx',
      contract_id: CONTRACT,
      caller_id: FROM,
      function: undefined,
      raw: { call_data: 'cb_...' },
    };
    expect(predicate(liveTx)).toBe(true);
  });
});

d('social-graph ingestion → read (DB-backed, mainnet identifiers)', () => {
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
    // contractService is only used by precheck(); the read paths under test
    // never touch it.
    readService = new SocialGraphService(edgeRepo, {} as any);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('replays the missed follow and serves the follower count + relationship', async () => {
    // The decoded events the backfill hands to processTransaction after
    // decoding th_23vad…Fi6's logs.
    await syncService.processTransaction(
      {
        hash: TX_HASH,
        block_height: HEIGHT,
        logs: {
          'social-graph': { data: [{ name: 'Followed', args: [FROM, TO] }] },
        },
      } as any,
      SyncDirectionEnum.Backward,
    );

    // Read proof: the followed account now reports a follower, and the pair-wise
    // relationship reports the edge — the two endpoints the bug showed empty.
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
    await syncService.processTransaction(
      {
        hash: TX_HASH,
        block_height: HEIGHT,
        logs: {
          'social-graph': { data: [{ name: 'Followed', args: [FROM, TO] }] },
        },
      } as any,
      SyncDirectionEnum.Backward,
    );
    expect(await readService.getFollowersCount(TO)).toBe(1);
  });
});
