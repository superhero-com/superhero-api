import { BigNumber } from 'bignumber.js';
import { RoomStateService } from './room-state.service';
import { TGR_COMMUNITY_UPSERTED, TgrCommunityUpsertedPayload } from '../events';
import type { Token } from '@/tokens/entities/token.entity';
import type { CommunityRoom } from '../entities/community-room.entity';

/**
 * Unit coverage for the canonical read/map/diff/emit path (Task 04 req §2–§5).
 *
 * The SDK + cached `getContract` are fully mocked: `resolveManagement` and
 * `readManagementState` are stubbed per test by replacing the contract instances
 * the cache returns. We assert the raw mapping (no decimal shift), the
 * moderator/muted set-diffs, `[TG]` defaults, deletion, and emission gating.
 */
describe('RoomStateService', () => {
  const SALE = 'ct_sale_1';
  const TOKEN_ADDR = 'ct_token_1';
  const MGMT = 'ct_mgmt_1';

  const makeToken = (overrides: Partial<Token> = {}): Token =>
    ({
      sale_address: SALE,
      address: TOKEN_ADDR,
      symbol: 'COMMUNITY',
      owner_address: 'ak_owner',
      creator_address: 'ak_creator',
      last_sync_block_height: 1234,
      ...overrides,
    }) as Token;

  type Harness = {
    service: RoomStateService;
    repo: { findOne: jest.Mock; upsert: jest.Mock };
    emit: jest.Mock;
    setManagement: (addr: string | undefined) => void;
    setState: (state: any) => void;
  };

  const makeHarness = (existing: CommunityRoom | null = null): Harness => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    const emit = jest.fn();
    const eventEmitter = { emit } as any;
    const aeSdkService = {
      sdk: { getContext: () => ({}) },
    } as any;

    const service = new RoomStateService(
      repo as any,
      aeSdkService,
      eventEmitter,
    );

    let managementAddr: string | undefined;
    let stateResult: any;

    // Stub the private getContract so resolveManagement / readManagementState
    // hit our fakes without touching the SDK.
    (service as any).getContract = jest.fn(async (address: string) => {
      if (address === MGMT) {
        return { get_state: async () => ({ decodedResult: stateResult }) };
      }
      // Factory contract: get_community_management(sale)
      return {
        get_community_management: async () => ({
          decodedResult: managementAddr,
        }),
      };
    });

    return {
      service,
      repo,
      emit,
      setManagement: (addr) => {
        managementAddr = addr;
      },
      setState: (state) => {
        stateResult = state;
      },
    };
  };

  const communityState = (overrides: Partial<any> = {}) => ({
    owner: 'ak_dao_owner',
    minimum_token_threshold: 1000n,
    is_private: false,
    moderator_accounts: new Set<string>(['ak_mod_a']),
    muted_user_ids: new Set<string>(['npub_muted_1']),
    meta_info: new Map(),
    ...overrides,
  });

  const lastPayload = (emit: jest.Mock) =>
    emit.mock.calls.find((c) => c[0] === TGR_COMMUNITY_UPSERTED)?.[1];

  it('maps get_state() onto community_room (Set→array, threshold raw)', async () => {
    const h = makeHarness(null);
    h.setManagement(MGMT);
    h.setState(communityState());

    const result = await h.service.readAndUpsertRoomState(makeToken());

    expect(result.isCommunity).toBe(true);
    expect(h.repo.upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = h.repo.upsert.mock.calls[0];
    expect(opts).toEqual({ conflictPaths: ['sale_address'] });
    expect(row.sale_address).toBe(SALE);
    expect(row.token_address).toBe(TOKEN_ADDR);
    expect(row.symbol).toBe('COMMUNITY');
    expect(row.owner_address).toBe('ak_dao_owner');
    expect(row.is_private).toBe(false);
    expect(row.is_community).toBe(true);
    expect(row.moderators).toEqual(['ak_mod_a']);
    expect(row.muted).toEqual(['npub_muted_1']);
    expect(BigNumber.isBigNumber(row.min_token_threshold)).toBe(true);
    expect(row.min_token_threshold.toFixed()).toBe('1000');
    expect(row.created_height).toBe(1234); // set on first insert
    expect(row.state_synced_at).toBeInstanceOf(Date);
  });

  it.each([
    ['0-decimal', '0'],
    ['6-decimal', '6000000'],
    ['18-decimal', '5000000000000000000'],
    ['zero', '0'],
  ])(
    'stores minimum_token_threshold raw for %s tokens',
    async (_label, raw) => {
      const h = makeHarness(null);
      h.setManagement(MGMT);
      h.setState(communityState({ minimum_token_threshold: BigInt(raw) }));

      await h.service.readAndUpsertRoomState(makeToken());

      const [row] = h.repo.upsert.mock.calls[0];
      expect(row.min_token_threshold.toFixed()).toBe(raw); // no decimal shifting
    },
  );

  it('emits a rich tgr.community.upserted on first insert (canonical saleAddress key)', async () => {
    const h = makeHarness(null);
    h.setManagement(MGMT);
    h.setState(communityState());

    await h.service.readAndUpsertRoomState(makeToken());

    expect(h.emit).toHaveBeenCalledWith(
      TGR_COMMUNITY_UPSERTED,
      expect.objectContaining({ saleAddress: SALE }),
    );
    const payload = lastPayload(h.emit) as TgrCommunityUpsertedPayload & any;
    expect(payload.saleAddress).toBe(SALE);
    expect(payload.is_community).toBe(true);
    expect(payload.min_token_threshold).toBe('1000');
    expect(payload.moderators).toEqual(['ak_mod_a']);
    expect(payload.muted).toEqual(['npub_muted_1']);
    expect(payload.deleted).toBe(false);
    // On a fresh insert the full sets are reported as added.
    expect(payload.changed.moderators).toEqual({
      added: ['ak_mod_a'],
      removed: [],
    });
    expect(payload.changed.muted).toEqual({
      added: ['npub_muted_1'],
      removed: [],
    });
  });

  it('does NOT emit on an idempotent re-run (no diff)', async () => {
    const existing: CommunityRoom = {
      sale_address: SALE,
      token_address: TOKEN_ADDR,
      symbol: 'COMMUNITY',
      owner_address: 'ak_dao_owner',
      is_private: false,
      min_token_threshold: new BigNumber('1000'),
      moderators: ['ak_mod_a'],
      muted: ['npub_muted_1'],
      is_community: true,
      state_synced_at: new Date(0),
      created_height: 1234,
      deleted: false,
    } as CommunityRoom;

    const h = makeHarness(existing);
    h.setManagement(MGMT);
    h.setState(communityState());

    const result = await h.service.readAndUpsertRoomState(makeToken());

    expect(result.emitted).toBe(false);
    expect(h.emit).not.toHaveBeenCalled();
    // Still upserts (re-stamps state_synced_at) but never overwrites created_height.
    expect(h.repo.upsert).toHaveBeenCalledTimes(1);
    const [row] = h.repo.upsert.mock.calls[0];
    expect(row.created_height).toBeUndefined();
  });

  it('computes moderator added/removed across an upsert and emits changed.moderators only on change', async () => {
    const existing: CommunityRoom = {
      sale_address: SALE,
      token_address: TOKEN_ADDR,
      symbol: 'COMMUNITY',
      owner_address: 'ak_dao_owner',
      is_private: false,
      min_token_threshold: new BigNumber('1000'),
      moderators: ['ak_mod_a', 'ak_mod_b'],
      muted: [],
      is_community: true,
      state_synced_at: new Date(0),
      created_height: 1,
      deleted: false,
    } as CommunityRoom;

    const h = makeHarness(existing);
    h.setManagement(MGMT);
    // mod_b removed, mod_c added; muted unchanged (empty)
    h.setState(
      communityState({
        moderator_accounts: new Set(['ak_mod_a', 'ak_mod_c']),
        muted_user_ids: new Set<string>(),
      }),
    );

    await h.service.readAndUpsertRoomState(makeToken());

    const payload = lastPayload(h.emit);
    expect(payload.changed.moderators).toEqual({
      added: ['ak_mod_c'],
      removed: ['ak_mod_b'],
    });
    expect(payload.changed.muted).toBeUndefined(); // muted did not change
  });

  it('preserves muted string ids verbatim and diffs added/removed', async () => {
    const existing: CommunityRoom = {
      sale_address: SALE,
      token_address: TOKEN_ADDR,
      symbol: 'COMMUNITY',
      owner_address: 'ak_dao_owner',
      is_private: false,
      min_token_threshold: new BigNumber('1000'),
      moderators: ['ak_mod_a'],
      muted: ['npub_keep', 'npub_gone'],
      is_community: true,
      state_synced_at: new Date(0),
      created_height: 1,
      deleted: false,
    } as CommunityRoom;

    const h = makeHarness(existing);
    h.setManagement(MGMT);
    h.setState(
      communityState({
        moderator_accounts: new Set(['ak_mod_a']),
        muted_user_ids: new Set(['npub_keep', 'npub_new']),
      }),
    );

    await h.service.readAndUpsertRoomState(makeToken());

    const [row] = h.repo.upsert.mock.calls[0];
    expect(row.muted).toEqual(['npub_keep', 'npub_new']); // verbatim, not resolved
    const payload = lastPayload(h.emit);
    expect(payload.changed.muted).toEqual({
      added: ['npub_new'],
      removed: ['npub_gone'],
    });
    expect(payload.changed.moderators).toBeUndefined();
  });

  it('flags threshold / owner / is_private changes individually', async () => {
    const existing: CommunityRoom = {
      sale_address: SALE,
      token_address: TOKEN_ADDR,
      symbol: 'COMMUNITY',
      owner_address: 'ak_old_owner',
      is_private: false,
      min_token_threshold: new BigNumber('1000'),
      moderators: [],
      muted: [],
      is_community: true,
      state_synced_at: new Date(0),
      created_height: 1,
      deleted: false,
    } as CommunityRoom;

    const h = makeHarness(existing);
    h.setManagement(MGMT);
    h.setState(
      communityState({
        owner: 'ak_new_owner',
        is_private: true,
        minimum_token_threshold: 2000n,
        moderator_accounts: new Set<string>(),
        muted_user_ids: new Set<string>(),
      }),
    );

    await h.service.readAndUpsertRoomState(makeToken());

    const payload = lastPayload(h.emit);
    expect(payload.changed.threshold).toBe(true);
    expect(payload.changed.owner).toBe(true);
    expect(payload.changed.is_private).toBe(true);
    expect(payload.changed.moderators).toBeUndefined();
  });

  it('applies [TG] defaults when get_community_management returns None', async () => {
    const h = makeHarness(null);
    h.setManagement(undefined); // None

    const result = await h.service.readAndUpsertRoomState(
      makeToken({ owner_address: 'ak_tg_owner' }),
    );

    expect(result.isCommunity).toBe(false);
    const [row] = h.repo.upsert.mock.calls[0];
    expect(row.is_community).toBe(false);
    expect(row.is_private).toBe(false);
    expect(row.min_token_threshold.toFixed()).toBe('0');
    expect(row.moderators).toEqual([]);
    expect(row.muted).toEqual([]);
    expect(row.owner_address).toBe('ak_tg_owner');
    // Emits on first insert.
    expect(h.emit).toHaveBeenCalledWith(
      TGR_COMMUNITY_UPSERTED,
      expect.objectContaining({ saleAddress: SALE, is_community: false }),
    );
  });

  it('[TG] defaults fall back to creator_address when owner_address is absent', async () => {
    const h = makeHarness(null);
    h.setManagement(undefined);

    await h.service.readAndUpsertRoomState(
      makeToken({
        owner_address: undefined as any,
        creator_address: 'ak_fallback',
      }),
    );

    const [row] = h.repo.upsert.mock.calls[0];
    expect(row.owner_address).toBe('ak_fallback');
  });

  it('marks an existing community deleted when management becomes None (row retained)', async () => {
    const existing: CommunityRoom = {
      sale_address: SALE,
      token_address: TOKEN_ADDR,
      symbol: 'COMMUNITY',
      owner_address: 'ak_dao_owner',
      is_private: false,
      min_token_threshold: new BigNumber('1000'),
      moderators: ['ak_mod_a'],
      muted: [],
      is_community: true,
      state_synced_at: new Date(0),
      created_height: 1,
      deleted: false,
    } as CommunityRoom;

    const h = makeHarness(existing);
    h.setManagement(undefined); // None now → community gone

    const result = await h.service.readAndUpsertRoomState(makeToken());

    expect(result.deleted).toBe(true);
    const [row] = h.repo.upsert.mock.calls[0];
    expect(row.deleted).toBe(true);
    expect(row.is_community).toBe(true); // retained, not downgraded
    // upsert (not delete) — the row is never destroyed.
    expect(h.repo.upsert).toHaveBeenCalledTimes(1);
    const payload = lastPayload(h.emit);
    expect(payload.deleted).toBe(true);
  });

  it('marks deleted when get_state reverts for a known community', async () => {
    const existing: CommunityRoom = {
      sale_address: SALE,
      token_address: TOKEN_ADDR,
      symbol: 'COMMUNITY',
      owner_address: 'ak_dao_owner',
      is_private: false,
      min_token_threshold: new BigNumber('1000'),
      moderators: [],
      muted: [],
      is_community: true,
      state_synced_at: new Date(0),
      created_height: 1,
      deleted: false,
    } as CommunityRoom;

    const h = makeHarness(existing);
    h.setManagement(MGMT);
    // get_state throws (DAO gone)
    (h.service as any).getContract = jest.fn(async (address: string) => {
      if (address === MGMT) {
        return {
          get_state: async () => {
            throw new Error('reverted');
          },
        };
      }
      return {
        get_community_management: async () => ({ decodedResult: MGMT }),
      };
    });

    const result = await h.service.readAndUpsertRoomState(makeToken());
    expect(result.deleted).toBe(true);
    const payload = lastPayload(h.emit);
    expect(payload.deleted).toBe(true);
  });

  it('does not re-emit deleted once already flagged', async () => {
    const existing: CommunityRoom = {
      sale_address: SALE,
      token_address: TOKEN_ADDR,
      symbol: 'COMMUNITY',
      owner_address: 'ak_dao_owner',
      is_private: false,
      min_token_threshold: new BigNumber('1000'),
      moderators: [],
      muted: [],
      is_community: true,
      state_synced_at: new Date(0),
      created_height: 1,
      deleted: true, // already deleted
    } as CommunityRoom;

    const h = makeHarness(existing);
    h.setManagement(undefined);

    const result = await h.service.readAndUpsertRoomState(makeToken());
    expect(result.emitted).toBe(false);
    expect(h.emit).not.toHaveBeenCalled();
  });
});
