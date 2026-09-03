import { SocialGraphPluginSyncService } from './social-graph-plugin-sync.service';
import { SyncDirectionEnum } from '../plugin.interface';

const A = 'ak_alice';
const B = 'ak_bob';

function makeService(events: Array<{ name: string; args: string[] }>) {
  const inserted: any[] = [];

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

  const edgeRepo: any = {
    createQueryBuilder: () => qb,
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const service = new SocialGraphPluginSyncService({} as any, edgeRepo);
  // Decode is exercised elsewhere; here we inject the decoded events directly to
  // test the edge mutations, not the SDK.
  jest
    .spyOn(service as any, 'getContract')
    .mockResolvedValue({ $decodeEvents: () => events });

  return { service, edgeRepo, inserted };
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
  it('Followed inserts a follow edge', async () => {
    const { service, inserted } = makeService([
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
  });

  it('Unfollowed deletes the follow edge', async () => {
    const { service, edgeRepo } = makeService([
      { name: 'Unfollowed', args: [A, B] },
    ]);
    await service.processTransaction(txWithLog(), SyncDirectionEnum.Backward);
    expect(edgeRepo.delete).toHaveBeenCalledWith({
      from_address: A,
      to_address: B,
      kind: 'follow',
    });
  });

  it('Blocked inserts a block edge and its cascade Unfollowed events clear both follows', async () => {
    // block(A, B) emits Unfollowed(B, A), Unfollowed(A, B), Blocked(A, B).
    const { service, edgeRepo, inserted } = makeService([
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
    expect(edgeRepo.delete).toHaveBeenCalledWith({
      from_address: B,
      to_address: A,
      kind: 'follow',
    });
    expect(edgeRepo.delete).toHaveBeenCalledWith({
      from_address: A,
      to_address: B,
      kind: 'follow',
    });
  });

  it('Unblocked deletes the block edge', async () => {
    const { service, edgeRepo } = makeService([
      { name: 'Unblocked', args: [A, B] },
    ]);
    await service.processTransaction(txWithLog(), SyncDirectionEnum.Backward);
    expect(edgeRepo.delete).toHaveBeenCalledWith({
      from_address: A,
      to_address: B,
      kind: 'block',
    });
  });

  it('writes nothing when the tx has no logs', async () => {
    const { service, edgeRepo, inserted } = makeService([]);
    const tx: any = { hash: 'th_2', block_height: 1, raw: {} };
    await service.processTransaction(tx, SyncDirectionEnum.Backward);
    expect(inserted).toEqual([]);
    expect(edgeRepo.delete).not.toHaveBeenCalled();
  });

  it('removeEdgesForTxs deletes edges by tx hash on reorg', async () => {
    const { service, edgeRepo } = makeService([]);
    await service.removeEdgesForTxs(['th_1', 'th_2']);
    expect(edgeRepo.delete).toHaveBeenCalledWith({
      tx_hash: expect.anything(),
    });
  });
});
