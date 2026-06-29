import { EventEmitter2 } from '@nestjs/event-emitter';
import { BigNumber } from 'bignumber.js';
import { Repository } from 'typeorm';
import {
  EligibilityService,
  isEligible,
  toShiftedBigNumber,
} from './eligibility.service';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { TokenBalance } from '../entities/token-balance.entity';
import { IdentityService } from './identity.service';
import { TGR_ELIGIBILITY_CHANGED } from '../events';

const HEX = 'a'.repeat(64);

function makeRoom(over: Partial<CommunityRoom> = {}): CommunityRoom {
  return {
    sale_address: 'ct_sale',
    token_address: 'ct_token',
    symbol: 'TGR',
    owner_address: 'ak_owner',
    is_private: false,
    min_token_threshold: new BigNumber('1000'),
    moderators: [],
    muted: [],
    is_community: false,
    state_synced_at: new Date(),
    created_height: 1,
    deleted: false,
    ...over,
  } as CommunityRoom;
}

function makeMembership(over: Partial<RoomMembership> = {}): RoomMembership {
  return {
    id: 1,
    sale_address: 'ct_sale',
    member_address: 'ak_member',
    member_pubkey: null as any,
    role: 'member',
    eligible: false,
    relay_state: 'removed',
    held_until_height: null as any,
    last_published_at: null as any,
    last_reconciled_at: null as any,
    updated_at: new Date(),
    ...over,
  } as RoomMembership;
}

describe('isEligible (pure helper)', () => {
  it('balance exactly == threshold (raw) → eligible', () => {
    expect(isEligible('1000', '1000', [], 'ak')).toBe(true);
  });

  it('balance == threshold-1 (raw) → ineligible', () => {
    expect(isEligible('999', '1000', [], 'ak')).toBe(false);
  });

  it('balance > threshold → eligible', () => {
    expect(isEligible('1001', '1000', [], 'ak')).toBe(true);
  });

  it('null balance treated as zero', () => {
    expect(isEligible(null, '1', [], 'ak')).toBe(false);
    expect(isEligible(null, '0', [], 'ak')).toBe(true);
  });

  it('muted holder above threshold → ineligible', () => {
    expect(isEligible('5000', '1000', ['ak'], 'ak')).toBe(false);
    // non-muted member with same balance stays eligible
    expect(isEligible('5000', '1000', ['someone_else'], 'ak')).toBe(true);
  });

  it('compares as raw integers far beyond Number precision (no float drift)', () => {
    const threshold = '1000000000000000000000'; // 1000 @ 18 decimals
    expect(isEligible('1000000000000000000000', threshold, [], 'ak')).toBe(
      true,
    );
    expect(isEligible('999999999999999999999', threshold, [], 'ak')).toBe(
      false,
    );
  });
});

describe('decimals correctness (raw-vs-raw, no double-shift)', () => {
  // Same human amount (100 tokens) across 0/6/18 decimals → raw threshold via
  // toShiftedBigNumber; a balance shifted the same way compares equal/correct.
  it.each([
    ['0 decimals', 0],
    ['6 decimals', 6],
    ['18 decimals', 18],
  ])('%s: human→raw shift then raw compare', (_label, decimals) => {
    const humanThreshold = '100';
    const humanBalance = '100';
    const thresholdRaw = toShiftedBigNumber(humanThreshold, decimals);
    const balanceRaw = toShiftedBigNumber(humanBalance, decimals);

    // exactly at threshold → eligible
    expect(isEligible(balanceRaw, thresholdRaw, [], 'ak')).toBe(true);

    // one base-unit below threshold → ineligible (proves no double-shift)
    const justUnder = balanceRaw.minus(1);
    expect(isEligible(justUnder, thresholdRaw, [], 'ak')).toBe(false);
  });

  it('toShiftedBigNumber coerces a string decimals (Token.decimals is a string)', () => {
    expect(toShiftedBigNumber('1', '18').toFixed()).toBe('1000000000000000000');
    expect(toShiftedBigNumber('1', '6').toFixed()).toBe('1000000');
    expect(toShiftedBigNumber('1', '0').toFixed()).toBe('1');
  });
});

describe('EligibilityService.nextRelayState (transitions)', () => {
  let service: EligibilityService;
  beforeEach(() => {
    service = new EligibilityService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new EventEmitter2(),
      { reconcileBatchSize: 500 } as any,
    );
  });

  it('eligible + linked + no/removed row → pending_add', () => {
    expect(
      service.nextRelayState(true, true, 'member', { prevState: null }),
    ).toBe('pending_add');
    expect(
      service.nextRelayState(true, true, 'member', { prevState: 'removed' }),
    ).toBe('pending_add');
    expect(
      service.nextRelayState(true, true, 'member', {
        prevState: 'pending_remove',
      }),
    ).toBe('pending_add');
  });

  it('eligible + linked + already added/pending_add → unchanged', () => {
    expect(
      service.nextRelayState(true, true, 'member', { prevState: 'added' }),
    ).toBe('added');
    expect(
      service.nextRelayState(true, true, 'member', {
        prevState: 'pending_add',
      }),
    ).toBe('pending_add');
  });

  it('unlinked invariant: eligible + no pubkey → always pending_add (never added/pending_remove)', () => {
    expect(
      service.nextRelayState(true, false, 'member', { prevState: null }),
    ).toBe('pending_add');
    expect(
      service.nextRelayState(true, false, 'member', { prevState: 'added' }),
    ).toBe('pending_add');
    expect(
      service.nextRelayState(true, false, 'member', {
        prevState: 'pending_remove',
      }),
    ).toBe('pending_add');
  });

  it('ineligible member added/pending_add → pending_remove', () => {
    expect(
      service.nextRelayState(false, true, 'member', { prevState: 'added' }),
    ).toBe('pending_remove');
    expect(
      service.nextRelayState(false, true, 'member', {
        prevState: 'pending_add',
      }),
    ).toBe('pending_remove');
  });

  it('admin exemption: ineligible admin keeps its state (no pending_remove)', () => {
    expect(
      service.nextRelayState(false, true, 'admin', { prevState: 'added' }),
    ).toBe('added');
    expect(
      service.nextRelayState(false, true, 'admin', {
        prevState: 'pending_add',
      }),
    ).toBe('pending_add');
  });
});

describe('EligibilityService.recomputeMember (mocked repos)', () => {
  let communityRoomRepo: jest.Mocked<
    Pick<Repository<CommunityRoom>, 'findOne'>
  >;
  let membershipRepo: jest.Mocked<
    Pick<Repository<RoomMembership>, 'findOne' | 'update' | 'insert'>
  >;
  let tokenBalanceRepo: jest.Mocked<Pick<Repository<TokenBalance>, 'findOne'>>;
  let identity: jest.Mocked<Pick<IdentityService, 'getPubkeyForAddress'>>;
  let emitter: EventEmitter2;
  let emitSpy: jest.SpyInstance;
  let service: EligibilityService;

  beforeEach(() => {
    communityRoomRepo = { findOne: jest.fn() } as any;
    membershipRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
    } as any;
    tokenBalanceRepo = { findOne: jest.fn() } as any;
    identity = { getPubkeyForAddress: jest.fn().mockResolvedValue(HEX) } as any;
    emitter = new EventEmitter2();
    emitSpy = jest.spyOn(emitter, 'emit');
    service = new EligibilityService(
      communityRoomRepo as any,
      membershipRepo as any,
      tokenBalanceRepo as any,
      identity as any,
      emitter,
      { reconcileBatchSize: 500 } as any,
    );
  });

  it('eligible flip inserts a new row and emits tgr.eligibility.changed', async () => {
    membershipRepo.findOne.mockResolvedValue(null);
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    const flipped = await service.recomputeMember(makeRoom(), 'ak_member');

    expect(flipped).toBe(true);
    expect(membershipRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = membershipRepo.insert.mock.calls[0][0] as any;
    expect(inserted.eligible).toBe(true);
    expect(inserted.member_pubkey).toBe(HEX);
    expect(inserted.relay_state).toBe('pending_add');
    expect(emitSpy).toHaveBeenCalledWith(TGR_ELIGIBILITY_CHANGED, {
      saleAddress: 'ct_sale',
      memberAddress: 'ak_member',
      eligible: true,
    });
  });

  it('moderator → role=admin', async () => {
    membershipRepo.findOne.mockResolvedValue(null);
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    await service.recomputeMember(
      makeRoom({ moderators: ['ak_member'] }),
      'ak_member',
    );

    const inserted = membershipRepo.insert.mock.calls[0][0] as any;
    expect(inserted.role).toBe('admin');
  });

  it('muted holder above threshold → eligible=false, no insert (never-created ineligible)', async () => {
    membershipRepo.findOne.mockResolvedValue(null);
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    const flipped = await service.recomputeMember(
      makeRoom({ muted: ['ak_member'] }),
      'ak_member',
    );

    expect(flipped).toBe(false);
    expect(membershipRepo.insert).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('muted flips an existing eligible+added row to pending_remove', async () => {
    membershipRepo.findOne.mockResolvedValue(
      makeMembership({
        eligible: true,
        relay_state: 'added',
        member_pubkey: HEX as any,
      }),
    );
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    const flipped = await service.recomputeMember(
      makeRoom({ muted: ['ak_member'] }),
      'ak_member',
    );

    expect(flipped).toBe(true);
    const update = membershipRepo.update.mock.calls[0][1] as any;
    expect(update.eligible).toBe(false);
    expect(update.relay_state).toBe('pending_remove');
    expect(emitSpy).toHaveBeenCalledWith(TGR_ELIGIBILITY_CHANGED, {
      saleAddress: 'ct_sale',
      memberAddress: 'ak_member',
      eligible: false,
    });
  });

  it('unlinked invariant: eligible holder with null pubkey → eligible=true, pending_add, no added/pending_remove, emits the flip', async () => {
    identity.getPubkeyForAddress.mockResolvedValue(null);
    membershipRepo.findOne.mockResolvedValue(null);
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    const flipped = await service.recomputeMember(makeRoom(), 'ak_member');

    expect(flipped).toBe(true);
    const inserted = membershipRepo.insert.mock.calls[0][0] as any;
    expect(inserted.eligible).toBe(true);
    expect(inserted.member_pubkey).toBeNull();
    expect(inserted.relay_state).toBe('pending_add');
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('unlinked + eligible never flips to pending_remove even if it was added', async () => {
    identity.getPubkeyForAddress.mockResolvedValue(null);
    membershipRepo.findOne.mockResolvedValue(
      makeMembership({
        eligible: true,
        relay_state: 'added',
        member_pubkey: null as any,
      }),
    );
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    const flipped = await service.recomputeMember(makeRoom(), 'ak_member');

    // eligible flag did not flip (still eligible) but relay_state pulled back.
    expect(flipped).toBe(false);
    const update = membershipRepo.update.mock.calls[0][1] as any;
    expect(update.eligible).toBe(true);
    expect(update.relay_state).toBe('pending_add');
  });

  it('admin exemption: admin whose balance drops below threshold is not set to pending_remove', async () => {
    membershipRepo.findOne.mockResolvedValue(
      makeMembership({
        role: 'admin',
        eligible: true,
        relay_state: 'added',
        member_pubkey: HEX as any,
      }),
    );
    // balance below threshold
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('0'),
    } as any);

    const flipped = await service.recomputeMember(
      makeRoom({ moderators: ['ak_member'] }),
      'ak_member',
    );

    expect(flipped).toBe(true); // eligible flipped to false
    const update = membershipRepo.update.mock.calls[0][1] as any;
    expect(update.eligible).toBe(false);
    expect(update.role).toBe('admin');
    expect(update.relay_state).toBe('added'); // NOT pending_remove
  });

  it('idempotency: re-running with unchanged inputs writes nothing and emits nothing', async () => {
    membershipRepo.findOne.mockResolvedValue(
      makeMembership({
        eligible: true,
        relay_state: 'added',
        role: 'member',
        member_pubkey: HEX as any,
      }),
    );
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    const flipped = await service.recomputeMember(makeRoom(), 'ak_member');

    expect(flipped).toBe(false);
    expect(membershipRepo.update).not.toHaveBeenCalled();
    expect(membershipRepo.insert).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('deleted room → existing eligible member desired-removed (eligible=false)', async () => {
    membershipRepo.findOne.mockResolvedValue(
      makeMembership({
        eligible: true,
        relay_state: 'added',
        member_pubkey: HEX as any,
      }),
    );
    // balance well above threshold — irrelevant because room.deleted
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('999999'),
    } as any);

    const flipped = await service.recomputeMember(
      makeRoom({ deleted: true }),
      'ak_member',
    );

    expect(flipped).toBe(true);
    expect(tokenBalanceRepo.findOne).not.toHaveBeenCalled(); // short-circuit
    const update = membershipRepo.update.mock.calls[0][1] as any;
    expect(update.eligible).toBe(false);
    expect(update.relay_state).toBe('pending_remove');
  });

  it('link→invite: an already-eligible UNLINKED row that links emits tgr.eligibility.changed (publishableAdd) with NO eligible-flip', async () => {
    // The §6.6 case the reactive link→invite fix targets: holder already eligible
    // (eligible=true) but unpublished (member_pubkey=null, pending_add). They link
    // their Nostr key → pubkey resolves now. `eligible` does NOT flip, but the row
    // becomes a publishable pending_add, so membership-sync MUST be notified.
    identity.getPubkeyForAddress.mockResolvedValue(HEX); // now linked
    membershipRepo.findOne.mockResolvedValue(
      makeMembership({
        eligible: true,
        relay_state: 'pending_add',
        member_pubkey: null as any,
      }),
    );
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    const flipped = await service.recomputeMember(makeRoom(), 'ak_member');

    expect(flipped).toBe(false); // eligible did not flip — it was already eligible
    // …but the row went unpublishable → publishable, so the emit MUST fire so
    // membership-sync publishes the 9000 reactively (not only on the periodic scan).
    expect(emitSpy).toHaveBeenCalledWith(TGR_ELIGIBILITY_CHANGED, {
      saleAddress: 'ct_sale',
      memberAddress: 'ak_member',
      eligible: true,
    });
    const update = membershipRepo.update.mock.calls[0][1] as any;
    expect(update.member_pubkey).toBe(HEX);
    expect(update.relay_state).toBe('pending_add');
  });

  it('no spurious emit: a stable already-added linked member recompute emits nothing', async () => {
    // Guards the publishableAdd condition against over-emitting: an `added` row that
    // re-computes unchanged must neither write nor emit (Req 10 idempotency).
    membershipRepo.findOne.mockResolvedValue(
      makeMembership({
        eligible: true,
        relay_state: 'added',
        role: 'member',
        member_pubkey: HEX as any,
      }),
    );
    tokenBalanceRepo.findOne.mockResolvedValue({
      balance: new BigNumber('5000'),
    } as any);

    const flipped = await service.recomputeMember(makeRoom(), 'ak_member');

    expect(flipped).toBe(false);
    expect(membershipRepo.update).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('EligibilityService.recomputeRoom (cursor batching, mocked QB)', () => {
  it('iterates batches until a short batch and recomputes every member', async () => {
    const room = makeRoom();
    const communityRoomRepo = { findOne: jest.fn().mockResolvedValue(room) };

    // 3 members; batchSize 2 → two batches (2 then 1).
    const members = ['ak_a', 'ak_b', 'ak_c'].map((member_address) =>
      makeMembership({
        member_address,
        eligible: false,
        relay_state: 'removed',
      }),
    );

    const getMany = jest
      .fn()
      // batch 1: > '' → first 2
      .mockResolvedValueOnce([members[0], members[1]])
      // batch 2: > 'ak_b' → last 1
      .mockResolvedValueOnce([members[2]]);

    const qb: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany,
    };
    const membershipRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    // all 3 above threshold → all flip to eligible
    const tokenBalanceRepo = {
      findOne: jest.fn().mockResolvedValue({ balance: new BigNumber('5000') }),
    };
    const identity = {
      getPubkeyForAddress: jest.fn().mockResolvedValue(HEX),
    };
    const emitter = new EventEmitter2();
    const emitSpy = jest.spyOn(emitter, 'emit');

    const service = new EligibilityService(
      communityRoomRepo as any,
      membershipRepo as any,
      tokenBalanceRepo as any,
      identity as any,
      emitter,
      { reconcileBatchSize: 2 } as any,
    );

    const flips = await service.recomputeRoom('ct_sale');

    expect(getMany).toHaveBeenCalledTimes(2);
    expect(flips).toBe(3);
    expect(membershipRepo.update).toHaveBeenCalledTimes(3);
    expect(emitSpy).toHaveBeenCalledTimes(3);
  });
});

describe('EligibilityService.recomputeRoomFromHolders (seed, batched reads)', () => {
  it('seeds members from the holder ledger with NO per-member token_holder/membership reads', async () => {
    const room = makeRoom(); // threshold 1000
    const communityRoomRepo = { findOne: jest.fn().mockResolvedValue(room) };
    // One positive holder (eligible) + one zero-balance row (not a holder).
    const tokenHolderRepo = {
      find: jest.fn().mockResolvedValue([
        { address: 'ak_holder', balance: new BigNumber('5000') },
        { address: 'ak_zero', balance: new BigNumber('0') },
      ]),
      findOne: jest.fn(), // MUST NOT be called — balances are pre-loaded
    };
    const membershipRepo = {
      find: jest.fn().mockResolvedValue([]), // no existing rows
      findOne: jest.fn(), // MUST NOT be called — `existing` passed as null
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    const identity = { getPubkeyForAddress: jest.fn().mockResolvedValue(HEX) };
    const emitter = new EventEmitter2();
    const service = new EligibilityService(
      communityRoomRepo as any,
      membershipRepo as any,
      tokenHolderRepo as any,
      identity as any,
      emitter,
      { reconcileBatchSize: 500 } as any,
    );

    const flips = await service.recomputeRoomFromHolders('ct_sale');

    // Only the positive holder is in the recompute set and becomes eligible.
    expect(flips).toBe(1);
    expect(membershipRepo.insert).toHaveBeenCalledTimes(1);
    expect(membershipRepo.insert.mock.calls[0][0].member_address).toBe(
      'ak_holder',
    );
    expect(membershipRepo.insert.mock.calls[0][0].eligible).toBe(true);
    // The whole point: batched — zero per-member reads.
    expect(tokenHolderRepo.findOne).not.toHaveBeenCalled();
    expect(membershipRepo.findOne).not.toHaveBeenCalled();
    expect(tokenHolderRepo.find).toHaveBeenCalledTimes(1);
    expect(membershipRepo.find).toHaveBeenCalledTimes(1);
  });
});
