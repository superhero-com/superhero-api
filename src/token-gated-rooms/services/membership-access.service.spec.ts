import { EventEmitter2 } from '@nestjs/event-emitter';
import { RoomMembership } from '../entities/room-membership.entity';
import {
  TGR_MEMBERSHIP_CHANGED,
  type TgrMembershipChangedPayload,
} from '../events';
import { MembershipAccessService } from './membership-access.service';

/**
 * Unit coverage for the access-transition ledger (access-ledger plan §3.4/§3.5) —
 * the fix for the ~hourly repeated "You now have access" push. Verifies:
 *   - a genuine gain records ONE grant + emits (first-ever = `is_first_grant`);
 *   - a re-add of an already-granted member (reconcile / `39002` regen) is a silent
 *     no-op — the churn that caused the repeat;
 *   - a loss ARMS the debounce (no push yet);
 *   - the finalizer emits ONE revoke past the grace window, but a re-add within the
 *     window is absorbed (NEITHER push).
 */
const SALE = 'ct_sale';
const MEMBER = 'ak_member';

function makeRow(over: Partial<RoomMembership> = {}): RoomMembership {
  return {
    id: 1,
    sale_address: SALE,
    member_address: MEMBER,
    member_pubkey: 'p',
    role: 'member',
    eligible: true,
    relay_state: 'added',
    access_state: 'none',
    access_changed_at: null as any,
    pending_revoke_since: null as any,
    pending_revoke_reason: null as any,
    held_until_height: null as any,
    last_published_at: null as any,
    last_reconciled_at: null as any,
    updated_at: new Date(),
    ...over,
  } as RoomMembership;
}

function setup(opts: { grace?: number; priorGrants?: number } = {}) {
  const membershipRepo = {
    update: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
  };
  let seq = 1;
  const eventRepo = {
    count: jest.fn().mockResolvedValue(opts.priorGrants ?? 0),
    create: jest.fn((v) => v),
    save: jest.fn(async (v) => ({ ...v, id: String(seq++) })),
  };
  const emitter = new EventEmitter2();
  const emitted: TgrMembershipChangedPayload[] = [];
  emitter.on(TGR_MEMBERSHIP_CHANGED, (p) => emitted.push(p));
  const service = new MembershipAccessService(
    membershipRepo as any,
    eventRepo as any,
    emitter,
    { accessRevokeGraceSec: opts.grace ?? 180 } as any,
  );
  return { service, membershipRepo, eventRepo, emitted };
}

describe('MembershipAccessService — gains', () => {
  it('none → granted records a first-grant + emits added(isFirstGrant=true)', async () => {
    const h = setup({ priorGrants: 0 });
    const row = makeRow({ access_state: 'none' });

    await h.service.recordAccessTransition(row, true, 'access_gained');

    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({ access_state: 'granted' }),
    );
    expect(h.eventRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'access_granted', reason: 'join', is_first_grant: true }),
    );
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      relayState: 'added',
      isFirstGrant: true,
      accessEventId: '1',
    });
  });

  it('regained (prior grant exists) → reason regained, isFirstGrant=false', async () => {
    const h = setup({ priorGrants: 1 });
    const row = makeRow({ access_state: 'none' });

    await h.service.recordAccessTransition(row, true, 'access_gained');

    expect(h.eventRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'regained', is_first_grant: false }),
    );
    expect(h.emitted[0]).toMatchObject({ isFirstGrant: false });
  });

  it('re-add of an already-granted member is a SILENT no-op (the flap/reconcile churn)', async () => {
    const h = setup();
    const row = makeRow({ access_state: 'granted' });

    await h.service.recordAccessTransition(row, true, 'access_gained');

    expect(h.eventRepo.save).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('re-add of a granted member with an armed revoke cancels the revoke silently', async () => {
    const h = setup();
    const row = makeRow({
      access_state: 'granted',
      pending_revoke_since: new Date(),
      pending_revoke_reason: 'eligibility_lost',
    });

    await h.service.recordAccessTransition(row, true, 'access_gained');

    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: 1 },
      { pending_revoke_since: null, pending_revoke_reason: null },
    );
    expect(h.emitted).toHaveLength(0);
  });
});

describe('MembershipAccessService — losses (debounced)', () => {
  it('granted → lost ARMS pending_revoke and does NOT emit', async () => {
    const h = setup();
    const row = makeRow({ access_state: 'granted', relay_state: 'removed' });

    await h.service.recordAccessTransition(row, false, 'eligibility_lost');

    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({
        pending_revoke_since: expect.any(Date),
        pending_revoke_reason: 'eligibility_lost',
      }),
    );
    expect(h.emitted).toHaveLength(0);
  });

  it('loss on a never-granted (none) row is a no-op', async () => {
    const h = setup();
    const row = makeRow({ access_state: 'none', relay_state: 'removed' });

    await h.service.recordAccessTransition(row, false, 'eligibility_lost');

    expect(h.membershipRepo.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});

describe('MembershipAccessService — finalizeDueRevokes', () => {
  it('still-removed past grace → ONE revoke emit + access_state=none', async () => {
    const h = setup();
    const armed = makeRow({
      access_state: 'granted',
      relay_state: 'removed',
      pending_revoke_since: new Date(Date.now() - 10 * 60_000),
      pending_revoke_reason: 'eligibility_lost',
    });
    h.membershipRepo.find = jest.fn().mockResolvedValue([armed]);

    const result = await h.service.finalizeDueRevokes();

    expect(result).toEqual({ revoked: 1, cancelled: 0 });
    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({ access_state: 'none' }),
    );
    expect(h.eventRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'access_revoked', reason: 'eligibility_lost' }),
    );
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({ relayState: 'removed', accessEventId: '1' });
  });

  it('re-added within grace (relay_state=added) → cancelled silently, NO push', async () => {
    const h = setup();
    const readded = makeRow({
      access_state: 'granted',
      relay_state: 'added', // came back before the finalizer ran
      pending_revoke_since: new Date(Date.now() - 10 * 60_000),
      pending_revoke_reason: 'eligibility_lost',
    });
    h.membershipRepo.find = jest.fn().mockResolvedValue([readded]);

    const result = await h.service.finalizeDueRevokes();

    expect(result).toEqual({ revoked: 0, cancelled: 1 });
    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: 1 },
      { pending_revoke_since: null, pending_revoke_reason: null },
    );
    expect(h.eventRepo.save).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});
