import {
  CommunityRoomStatePlugin,
  MANAGEMENT_CHANGED_EVENTS,
} from './community-room-state.plugin';
import { BCL_CONTRACT } from '@/plugins/bcl/config/bcl.config';
import { BCL_FUNCTIONS } from '@/configs/constants';
import type { Tx } from '@/mdw-sync/entities/tx.entity';
import type { Token } from '@/tokens/entities/token.entity';

/**
 * Unit coverage for the reactive plugin shell (Task 04 req §1, §8).
 *
 * Predicates: `create_community` on the BCL factory matches community-created; a
 * `MuteUserId` log on an allowlisted management address matches
 * management-changed; an unrelated call matches neither. Reorg: `onReorg`
 * resolves affected rooms from the rolled-back create-tx hashes and re-derives
 * via `readAndUpsertRoomState` (live `get_state()`), and is a no-op on empty /
 * unrelated hashes.
 */
describe('CommunityRoomStatePlugin', () => {
  const FACTORY = BCL_CONTRACT.contractAddress;
  const MGMT = 'ct_mgmt_allow';
  const SALE = 'ct_sale_1';

  type Deps = {
    plugin: CommunityRoomStatePlugin;
    roomState: {
      readAndUpsertRoomState: jest.Mock;
      resolveManagementAddress: jest.Mock;
    };
    sync: { decodeManagementEventNames: jest.Mock };
    tokenRepo: { findOne: jest.Mock; find: jest.Mock };
    roomRepo: { find: jest.Mock };
    reorgEviction: { bufferEvictions: jest.Mock };
  };

  const makePlugin = (): Deps => {
    const roomState = {
      readAndUpsertRoomState: jest.fn().mockResolvedValue({ emitted: true }),
      resolveManagementAddress: jest.fn().mockResolvedValue(MGMT),
    };
    const sync = {
      decodeManagementEventNames: jest.fn().mockResolvedValue(['MuteUserId']),
    };
    const tokenRepo = {
      findOne: jest.fn().mockResolvedValue({ sale_address: SALE } as Token),
      find: jest.fn().mockResolvedValue([]),
    };
    const roomRepo = { find: jest.fn().mockResolvedValue([]) };
    const config = { communityTokenRefreshSec: 300 } as any;

    const reorgEviction = { bufferEvictions: jest.fn().mockResolvedValue(0) };

    const plugin = new CommunityRoomStatePlugin(
      {} as any, // txRepository
      {} as any, // pluginSyncStateRepository
      tokenRepo as any,
      roomRepo as any,
      roomState as any,
      sync as any,
      reorgEviction as any,
      config,
    );
    return { plugin, roomState, sync, tokenRepo, roomRepo, reorgEviction };
  };

  it('exposes the canonical name + version and empty batch filters', () => {
    const { plugin } = makePlugin();
    expect(plugin.name).toBe('community-room-state');
    expect(plugin.version).toBe(1);
    expect(plugin.filters()).toEqual([]);
  });

  it('matches create_community on the BCL factory (community-created)', () => {
    const { plugin } = makePlugin();
    expect(
      plugin.isCommunityCreatedTx({
        type: 'ContractCallTx',
        function: BCL_FUNCTIONS.create_community,
        contract_id: FACTORY,
      } as Partial<Tx>),
    ).toBe(true);
  });

  it('does NOT match create_community on a non-factory contract', () => {
    const { plugin } = makePlugin();
    expect(
      plugin.isCommunityCreatedTx({
        type: 'ContractCallTx',
        function: BCL_FUNCTIONS.create_community,
        contract_id: 'ct_some_other',
      } as Partial<Tx>),
    ).toBe(false);
  });

  it('does NOT match a non-create function on the factory', () => {
    const { plugin } = makePlugin();
    expect(
      plugin.isCommunityCreatedTx({
        type: 'ContractCallTx',
        function: BCL_FUNCTIONS.buy,
        contract_id: FACTORY,
      } as Partial<Tx>),
    ).toBe(false);
  });

  it('matches a call on an allowlisted management address (management-changed)', () => {
    const { plugin } = makePlugin();
    plugin.setManagementAllowlistEntry(MGMT, SALE);
    expect(
      plugin.isManagementContract({
        type: 'ContractCallTx',
        contract_id: MGMT,
      } as Partial<Tx>),
    ).toBe(true);
  });

  it('does NOT match a management call on an un-allowlisted address', () => {
    const { plugin } = makePlugin();
    expect(
      plugin.isManagementContract({
        type: 'ContractCallTx',
        contract_id: 'ct_unknown_mgmt',
      } as Partial<Tx>),
    ).toBe(false);
  });

  it('MANAGEMENT_CHANGED_EVENTS contains the verified ACI variants', () => {
    for (const name of [
      'ChangeMinimumTokenThreshold',
      'AddModerator',
      'DeleteModerator',
      'MuteUserId',
      'UnmuteUserId',
      'SetOwner',
      'ChangedMetaInfo',
    ]) {
      expect(MANAGEMENT_CHANGED_EVENTS.has(name)).toBe(true);
    }
  });

  it('onLiveTx (community-created) → resolves the token by create_tx_hash and upserts', async () => {
    const { plugin, roomState, tokenRepo } = makePlugin();
    plugin.refreshAllowlist = jest.fn().mockResolvedValue(undefined);
    tokenRepo.findOne.mockResolvedValue({ sale_address: SALE } as Token);

    await plugin.onLiveTx({
      hash: 'th_create_1',
      type: 'ContractCallTx',
      function: BCL_FUNCTIONS.create_community,
      contract_id: FACTORY,
    } as any);

    expect(tokenRepo.findOne).toHaveBeenCalledWith({
      where: { create_tx_hash: 'th_create_1' },
    });
    expect(roomState.readAndUpsertRoomState).toHaveBeenCalledTimes(1);
  });

  it('onLiveTx (management-changed, MuteUserId) → re-reads room state', async () => {
    const { plugin, roomState, sync } = makePlugin();
    plugin.setManagementAllowlistEntry(MGMT, SALE);
    sync.decodeManagementEventNames.mockResolvedValue(['MuteUserId']);

    await plugin.onLiveTx({
      hash: 'th_mute_1',
      type: 'ContractCallTx',
      contract_id: MGMT,
      raw: { log: [{ address: MGMT }] },
    } as any);

    expect(sync.decodeManagementEventNames).toHaveBeenCalled();
    expect(roomState.readAndUpsertRoomState).toHaveBeenCalledTimes(1);
  });

  it('onLiveTx (management call with only non-management events) → does nothing', async () => {
    const { plugin, roomState, sync } = makePlugin();
    plugin.setManagementAllowlistEntry(MGMT, SALE);
    sync.decodeManagementEventNames.mockResolvedValue(['SomeUnrelatedEvent']);

    await plugin.onLiveTx({
      hash: 'th_x',
      type: 'ContractCallTx',
      contract_id: MGMT,
      raw: { log: [{ address: MGMT }] },
    } as any);

    expect(roomState.readAndUpsertRoomState).not.toHaveBeenCalled();
  });

  it('onLiveTx ignores an unrelated contract call', async () => {
    const { plugin, roomState } = makePlugin();
    await plugin.onLiveTx({
      hash: 'th_unrelated',
      type: 'ContractCallTx',
      contract_id: 'ct_random',
      function: 'do_thing',
    } as any);
    expect(roomState.readAndUpsertRoomState).not.toHaveBeenCalled();
  });

  it('onReorg recomputes affected rooms from create_tx_hash and re-derives live state, then buffers evictions', async () => {
    const { plugin, roomState, tokenRepo, reorgEviction } = makePlugin();
    plugin.refreshAllowlist = jest.fn().mockResolvedValue(undefined);
    const affected = [
      { sale_address: 'ct_a', create_tx_hash: 'th_1' },
      { sale_address: 'ct_b', create_tx_hash: 'th_2' },
    ] as Token[];
    tokenRepo.find.mockResolvedValue(affected);

    await plugin.onReorg(['th_1', 'th_2']);

    expect(tokenRepo.find).toHaveBeenCalledTimes(1);
    expect(roomState.readAndUpsertRoomState).toHaveBeenCalledTimes(2);
    expect(roomState.readAndUpsertRoomState).toHaveBeenCalledWith(affected[0]);
    expect(roomState.readAndUpsertRoomState).toHaveBeenCalledWith(affected[1]);
    // Task 11: removals are buffered, never published from onReorg (§6).
    expect(reorgEviction.bufferEvictions).toHaveBeenCalledWith([
      'ct_a',
      'ct_b',
    ]);
  });

  it('onReorg is a no-op on empty removedTxHashes', async () => {
    const { plugin, roomState, tokenRepo } = makePlugin();
    await plugin.onReorg([]);
    expect(tokenRepo.find).not.toHaveBeenCalled();
    expect(roomState.readAndUpsertRoomState).not.toHaveBeenCalled();
  });

  it('onReorg is a no-op when no rooms reference the rolled-back txs', async () => {
    const { plugin, roomState, tokenRepo } = makePlugin();
    tokenRepo.find.mockResolvedValue([]);
    await plugin.onReorg(['th_unrelated']);
    expect(roomState.readAndUpsertRoomState).not.toHaveBeenCalled();
  });

  it('refreshAllowlist rebuilds the set from is_community rooms', async () => {
    const { plugin, roomState, roomRepo } = makePlugin();
    roomRepo.find.mockResolvedValue([
      { sale_address: 'ct_s1' },
      { sale_address: 'ct_s2' },
    ]);
    roomState.resolveManagementAddress
      .mockResolvedValueOnce('ct_m1')
      .mockResolvedValueOnce('ct_m2');

    await plugin.refreshAllowlist(true);

    const allow = plugin.getManagementAllowlist();
    expect(allow.get('ct_m1')).toBe('ct_s1');
    expect(allow.get('ct_m2')).toBe('ct_s2');
    expect(allow.size).toBe(2);
  });
});
