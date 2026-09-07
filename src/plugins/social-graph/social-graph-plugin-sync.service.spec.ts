import { SocialGraphPluginSyncService } from './social-graph-plugin-sync.service';
import { SyncDirectionEnum } from '../plugin.interface';

const A = 'ak_alice';
const B = 'ak_bob';

function makeService(
  events: Array<{ name: string; args: string[] }>,
  removed: Array<{ from_address: string; to_address: string }> = [],
) {
  const inserted: any[] = [];
  const deleted: any[] = [];
  // The address of every recompute (manager.query with the counts upsert).
  const recomputed: string[] = [];

  const qb: any = {
    insert: () => qb,
    into: () => qb,
    values: (v: any) => {
      inserted.push(v);
      return qb;
    },
    orIgnore: () => qb,
    execute: jest.fn().mockResolvedValue(undefined),
  };

  // A manager that records the recompute upserts and the edge mutations, so the
  // tests can assert every mutation recomputes both affected addresses.
  const manager: any = {
    createQueryBuilder: () => qb,
    delete: jest.fn().mockImplementation((_entity: any, criteria: any) => {
      deleted.push(criteria);
      return Promise.resolve(undefined);
    }),
    find: jest.fn().mockResolvedValue(removed),
    query: jest.fn().mockImplementation((_sql: string, params: any[]) => {
      recomputed.push(params[0]);
      return Promise.resolve(undefined);
    }),
  };

  const edgeRepo: any = {
    manager: {
      transaction: (fn: (m: any) => Promise<void>) => fn(manager),
    },
  };

  const service = new SocialGraphPluginSyncService({} as any, edgeRepo);
  // Decode is exercised elsewhere; here we inject the decoded events directly to
  // test the edge mutations, not the SDK.
  jest
    .spyOn(service as any, 'getContract')
    .mockResolvedValue({ $decodeEvents: () => events });

  return { service, manager, inserted, deleted, recomputed };
}

function txWithLog(): any {
  return {
    hash: 'th_1',
    block_height: 100,
    contract_id: 'ct_test',
    raw: { log: [{ address: 'ct_test' }] },
  };
}

describe('SocialGraphPluginSyncService', () => {
  it('Followed inserts a follow edge and recomputes both addresses', async () => {
    const { service, inserted, recomputed } = makeService([
      { name: 'Followed', args: [A, B] },
    ]);
    await service.processTransaction(txWithLog(), SyncDirectionEnum.Backward);
    expect(inserted).toEqual([
      {
        from_address: A,
        to_address: B,
        kind: 'follow',
        height: 100,
        tx_hash: 'th_1',
      },
    ]);
    // Both the follower and the followed address are recomputed, never a delta.
    expect(recomputed).toEqual([A, B]);
  });

  it('Unfollowed deletes the follow edge and recomputes both addresses', async () => {
    const { service, deleted, recomputed } = makeService([
      { name: 'Unfollowed', args: [A, B] },
    ]);
    await service.processTransaction(txWithLog(), SyncDirectionEnum.Backward);
    expect(deleted).toContainEqual({
      from_address: A,
      to_address: B,
      kind: 'follow',
    });
    expect(recomputed).toEqual([A, B]);
  });

  it('Blocked inserts a block edge and its cascade Unfollowed events clear both follows', async () => {
    // block(A, B) emits Unfollowed(B, A), Unfollowed(A, B), Blocked(A, B).
    const { service, deleted, inserted } = makeService([
      { name: 'Unfollowed', args: [B, A] },
      { name: 'Unfollowed', args: [A, B] },
      { name: 'Blocked', args: [A, B] },
    ]);
    await service.processTransaction(txWithLog(), SyncDirectionEnum.Backward);

    expect(inserted).toEqual([
      {
        from_address: A,
        to_address: B,
        kind: 'block',
        height: 100,
        tx_hash: 'th_1',
      },
    ]);
    expect(deleted).toContainEqual({
      from_address: B,
      to_address: A,
      kind: 'follow',
    });
    expect(deleted).toContainEqual({
      from_address: A,
      to_address: B,
      kind: 'follow',
    });
  });

  it('Unblocked deletes the block edge', async () => {
    const { service, deleted } = makeService([
      { name: 'Unblocked', args: [A, B] },
    ]);
    await service.processTransaction(txWithLog(), SyncDirectionEnum.Backward);
    expect(deleted).toContainEqual({
      from_address: A,
      to_address: B,
      kind: 'block',
    });
  });

  it('writes nothing when the tx has no logs', async () => {
    const { service, inserted, deleted, recomputed } = makeService([]);
    const tx: any = { hash: 'th_2', block_height: 1, raw: {} };
    await service.processTransaction(tx, SyncDirectionEnum.Backward);
    expect(inserted).toEqual([]);
    expect(deleted).toEqual([]);
    expect(recomputed).toEqual([]);
  });

  it('removeEdgesForTxs deletes edges by tx hash and recomputes affected addresses', async () => {
    const { service, deleted, recomputed } = makeService(
      [],
      [{ from_address: A, to_address: B }],
    );
    await service.removeEdgesForTxs(['th_1', 'th_2']);
    expect(deleted).toContainEqual({ tx_hash: expect.anything() });
    // Every address whose edge was removed is recomputed.
    expect(recomputed.sort()).toEqual([A, B]);
  });
});
