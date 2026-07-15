import { RoomRecheckService } from './room-recheck.service';

/**
 * Unit tests for the on-demand recheck heal paths. The service composes
 * eligibility recompute + a relay `39002` read + DB heal / publish; here we mock
 * each collaborator and assert the convergence decisions.
 */
describe('RoomRecheckService', () => {
  const SALE = 'ct_sophia';
  const ADDR = 'ak_caller';
  const PUBKEY = 'df8b0d3ehexpubkey';
  const RELAY_CONFIG = { nostrRelayUrl: 'ws://r', nostrBotNsec: 'nsec1x' };

  const makeHarness = (opts: {
    token?: any;
    room?: any;
    membership?: any;
    relayMembers?: Set<string>;
    relayHealthy?: boolean;
    config?: any;
  }) => {
    const tokenRow = {
      sale_address: SALE,
      nostr_group_id: SALE,
      ...opts.token,
    };
    const tokenRepo = {
      findOne: jest.fn(async () => ({ ...tokenRow })),
      update: jest.fn(async () => ({})),
    } as any;
    const communityRoomRepo = {
      findOne: jest.fn(async () =>
        opts.room === null
          ? null
          : {
              sale_address: SALE,
              token_address: 'ct_aex9',
              symbol: 'SOPHIA',
              is_private: false,
              min_token_threshold: '1',
              is_community: false,
              ...opts.room,
            },
      ),
    } as any;
    const membershipRepo = {
      findOne: jest.fn(async () =>
        opts.membership === null ? null : { ...opts.membership },
      ),
      update: jest.fn(async () => ({})),
    } as any;
    const publishQueue = { add: jest.fn(async () => ({})) } as any;
    const relay = {
      isHealthy: jest.fn(() => opts.relayHealthy ?? true),
      fetchGroupMembers: jest.fn(async () => opts.relayMembers ?? new Set()),
    } as any;
    const eligibility = { recomputeMember: jest.fn(async () => false) } as any;
    const roomBackfill = { requestRoom: jest.fn(async () => ({})) } as any;
    const config = opts.config ?? RELAY_CONFIG;

    const service = new RoomRecheckService(
      tokenRepo,
      communityRoomRepo,
      membershipRepo,
      publishQueue,
      relay,
      eligibility,
      roomBackfill,
      config,
    );
    return {
      service,
      tokenRepo,
      membershipRepo,
      publishQueue,
      relay,
      eligibility,
      roomBackfill,
    };
  };

  it('returns null when the sale address is not a gated room', async () => {
    const h = makeHarness({ room: null });
    expect(await h.service.recheck(ADDR, SALE)).toBeNull();
  });

  it('recomputes the caller eligibility before reconciling', async () => {
    const h = makeHarness({
      membership: {
        id: 1,
        member_address: ADDR,
        member_pubkey: PUBKEY,
        eligible: true,
        relay_state: 'added',
        role: 'member',
      },
      relayMembers: new Set([PUBKEY]),
    });
    await h.service.recheck(ADDR, SALE);
    expect(h.eligibility.recomputeMember).toHaveBeenCalledTimes(1);
  });

  it('relay-ahead heal: group exists on relay but DB lost the created marker → stamps created/room_id', async () => {
    const h = makeHarness({
      token: { nostr_room_state: 'pending', room_id: null },
      membership: {
        id: 1,
        member_address: ADDR,
        member_pubkey: PUBKEY,
        eligible: true,
        relay_state: 'added',
        role: 'member',
      },
      relayMembers: new Set([PUBKEY]),
    });
    await h.service.recheck(ADDR, SALE);
    expect(h.tokenRepo.update).toHaveBeenCalledWith(
      { sale_address: SALE },
      expect.objectContaining({
        nostr_room_state: 'created',
        has_nostr_room: true,
        room_id: SALE,
      }),
    );
  });

  it('caller-present heal: caller in 39002 but DB pending_add → flips to added', async () => {
    const h = makeHarness({
      token: { nostr_room_state: 'created', room_id: SALE },
      membership: {
        id: 7,
        member_address: ADDR,
        member_pubkey: PUBKEY,
        eligible: true,
        relay_state: 'pending_add',
        role: 'member',
      },
      relayMembers: new Set([PUBKEY]),
    });
    await h.service.recheck(ADDR, SALE);
    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: 7 },
      expect.objectContaining({ relay_state: 'added' }),
    );
    expect(h.publishQueue.add).not.toHaveBeenCalled();
  });

  it('caller-missing publish: eligible+linked but absent from 39002 → enqueues a 9000 put-user', async () => {
    const h = makeHarness({
      token: { nostr_room_state: 'created', room_id: SALE },
      membership: {
        id: 9,
        member_address: ADDR,
        member_pubkey: PUBKEY,
        eligible: true,
        relay_state: 'pending_add',
        role: 'member',
      },
      relayMembers: new Set(['someoneelse']),
    });
    await h.service.recheck(ADDR, SALE);
    expect(h.publishQueue.add).toHaveBeenCalledTimes(1);
    // room already created → no re-request
    expect(h.roomBackfill.requestRoom).not.toHaveBeenCalled();
  });

  it('skips the relay read entirely when no relay is configured', async () => {
    const h = makeHarness({
      config: { nostrRelayUrl: '', nostrBotNsec: '' },
      membership: {
        id: 1,
        member_address: ADDR,
        member_pubkey: PUBKEY,
        eligible: true,
        relay_state: 'pending_add',
        role: 'member',
      },
    });
    const view = await h.service.recheck(ADDR, SALE);
    expect(h.relay.fetchGroupMembers).not.toHaveBeenCalled();
    // still returns the (recomputed) DB view
    expect(view?.relay_state).toBe('pending_add');
  });

  it('returns the refreshed caller view with derived readable', async () => {
    const h = makeHarness({
      token: { nostr_room_state: 'created', room_id: SALE },
      membership: {
        id: 1,
        member_address: ADDR,
        member_pubkey: PUBKEY,
        eligible: true,
        relay_state: 'added',
        role: 'member',
      },
      relayMembers: new Set([PUBKEY]),
    });
    const view = await h.service.recheck(ADDR, SALE);
    expect(view).toMatchObject({
      sale_address: SALE,
      relay_state: 'added',
      member_pubkey: PUBKEY,
      readable: true,
    });
  });
});
