import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Account } from '@/account/entities/account.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { IdentityService } from './identity.service';
import { IdentityBackfillService } from './identity-backfill.service';
import tgrConfig from '../config/tgr.config';

// nostr-tools/nip19 mocked (see identity.service.spec.ts).
const HEX = 'a'.repeat(64);
const NPUB = 'npub1valid';

jest.mock('nostr-tools/nip19', () => ({
  decode: (value: string) => {
    if (value === NPUB) return { type: 'npub', data: 'a'.repeat(64) };
    throw new Error('invalid bech32');
  },
}));

const PROVIDER = 'nostr';
const LINKED_HEX = 'ak_linked_hex';
const LINKED_NPUB = 'ak_linked_npub';
const NO_NOSTR = 'ak_no_nostr';
const MALFORMED = 'ak_malformed';

describe('IdentityBackfillService (Task 05)', () => {
  let backfill: IdentityBackfillService;
  let identity: IdentityService;
  let accountRepo: { find: jest.Mock };
  let membershipRepo: { update: jest.Mock; createQueryBuilder: jest.Mock };
  let memberQb: {
    innerJoin: jest.Mock;
    select: jest.Mock;
    where: jest.Mock;
    groupBy: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(async () => {
    memberQb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    accountRepo = { find: jest.fn().mockResolvedValue([]) };
    membershipRepo = {
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(memberQb),
    };

    // Real IdentityService so setCacheEntry/clearCacheEntry/provider behave for
    // real; its repos are stubbed (the backfill drives all writes).
    const moduleRef = await Test.createTestingModule({
      providers: [
        IdentityBackfillService,
        IdentityService,
        { provide: getRepositoryToken(Account), useValue: accountRepo },
        {
          provide: getRepositoryToken(RoomMembership),
          useValue: membershipRepo,
        },
        {
          provide: tgrConfig.KEY,
          useValue: { nostrLinkProvider: PROVIDER, backfillBatchSize: 200 },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    backfill = moduleRef.get(IdentityBackfillService);
    identity = moduleRef.get(IdentityService);
  });

  it('resolves linked holders (hex + npub), leaves unlinked/malformed null', async () => {
    memberQb.getRawMany.mockResolvedValueOnce([
      { member_address: LINKED_HEX },
      { member_address: LINKED_NPUB },
      { member_address: NO_NOSTR },
      { member_address: MALFORMED },
    ]);
    accountRepo.find.mockResolvedValueOnce([
      { address: LINKED_HEX, links: { [PROVIDER]: HEX } },
      { address: LINKED_NPUB, links: { [PROVIDER]: NPUB } },
      { address: NO_NOSTR, links: { x: 'x:foo' } },
      { address: MALFORMED, links: { [PROVIDER]: 'deadbeef' } },
    ]);

    const result = await backfill.run();

    expect(result).toEqual({ scanned: 4, linked: 2, unlinked: 2 });

    // Linked holders get their hex written.
    expect(membershipRepo.update).toHaveBeenCalledWith(
      { member_address: LINKED_HEX },
      { member_pubkey: HEX },
    );
    expect(membershipRepo.update).toHaveBeenCalledWith(
      { member_address: LINKED_NPUB },
      { member_pubkey: HEX },
    );
    // Unlinked & malformed are nulled (invariant), never the malformed value.
    expect(membershipRepo.update).toHaveBeenCalledWith(
      { member_address: NO_NOSTR },
      { member_pubkey: null },
    );
    expect(membershipRepo.update).toHaveBeenCalledWith(
      { member_address: MALFORMED },
      { member_pubkey: null },
    );
    // No update ever carries the malformed value.
    for (const [, set] of membershipRepo.update.mock.calls) {
      expect(set.member_pubkey === 'deadbeef').toBe(false);
    }

    // Cache seeded for the two linked holders.
    expect(identity.cacheSize).toBe(2);
    expect(await identity.getPubkeyForAddress(LINKED_HEX)).toBe(HEX);
  });

  it('is cursor-batched: pages until a short batch and never writes eligibility/relay_state', async () => {
    // batchSize 2 → two full pages then a short page ends the loop.
    memberQb.getRawMany
      .mockResolvedValueOnce([
        { member_address: 'ak_a' },
        { member_address: 'ak_b' },
      ])
      .mockResolvedValueOnce([
        { member_address: 'ak_c' },
        { member_address: 'ak_d' },
      ])
      .mockResolvedValueOnce([{ member_address: 'ak_e' }]);
    accountRepo.find.mockResolvedValue([]); // all unlinked

    const result = await backfill.run({ batchSize: 2 });

    expect(result.scanned).toBe(5);
    expect(result.unlinked).toBe(5);
    // 3 page queries (2,2,1) — the short final page stops the loop.
    expect(memberQb.getRawMany).toHaveBeenCalledTimes(3);
    // Cursor advanced: the 2nd page query filtered on the last addr of page 1.
    expect(memberQb.where).toHaveBeenCalledWith('m.member_address > :cursor', {
      cursor: '',
    });
    expect(memberQb.where).toHaveBeenCalledWith('m.member_address > :cursor', {
      cursor: 'ak_b',
    });
    expect(memberQb.where).toHaveBeenCalledWith('m.member_address > :cursor', {
      cursor: 'ak_d',
    });
    // This service only ever writes member_pubkey.
    for (const [, set] of membershipRepo.update.mock.calls) {
      expect(Object.keys(set)).toEqual(['member_pubkey']);
    }
  });

  it('is idempotent: a second run produces the same writes', async () => {
    memberQb.getRawMany
      .mockResolvedValueOnce([{ member_address: LINKED_HEX }])
      .mockResolvedValueOnce([{ member_address: LINKED_HEX }]);
    accountRepo.find.mockResolvedValue([
      { address: LINKED_HEX, links: { [PROVIDER]: HEX } },
    ]);

    const a = await backfill.run();
    const b = await backfill.run();
    expect(a).toEqual(b);
    expect(a).toEqual({ scanned: 1, linked: 1, unlinked: 0 });
  });
});
