import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Account } from '@/account/entities/account.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { IdentityService } from './identity.service';
import { TGR_LINK_CHANGED } from '../events';
import tgrConfig from '../config/tgr.config';

// nostr-tools/nip19 is mocked (real module pulls in @noble/* ESM, untransformable
// by ts-jest). Map one known npub ↔ hex so normalization is exercised end-to-end.
const HEX = 'a'.repeat(64);
const NPUB = 'npub1valid';

jest.mock('nostr-tools/nip19', () => ({
  decode: (value: string) => {
    if (value === NPUB || value === NPUB.toLowerCase()) {
      return { type: 'npub', data: 'a'.repeat(64) };
    }
    throw new Error('invalid bech32');
  },
}));

const ADDRESS = 'ak_holder1';
const ADDRESS2 = 'ak_holder2';
const PROVIDER = 'nostr';

describe('IdentityService (Task 05)', () => {
  let service: IdentityService;
  let accountRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let membershipRepo: { update: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let qb: {
    select: jest.Mock;
    where: jest.Mock;
    getMany: jest.Mock;
  };

  beforeEach(async () => {
    qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    accountRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    membershipRepo = { update: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emit: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IdentityService,
        { provide: getRepositoryToken(Account), useValue: accountRepo },
        {
          provide: getRepositoryToken(RoomMembership),
          useValue: membershipRepo,
        },
        {
          provide: tgrConfig.KEY,
          useValue: { nostrLinkProvider: PROVIDER },
        },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = moduleRef.get(IdentityService);
  });

  describe('getPubkeyForAddress', () => {
    it('returns hex for a holder linked with a hex pubkey', async () => {
      accountRepo.findOne.mockResolvedValue({
        address: ADDRESS,
        links: { [PROVIDER]: HEX },
      });
      expect(await service.getPubkeyForAddress(ADDRESS)).toBe(HEX);
    });

    it('returns hex for a holder linked with an npub', async () => {
      accountRepo.findOne.mockResolvedValue({
        address: ADDRESS,
        links: { [PROVIDER]: NPUB },
      });
      expect(await service.getPubkeyForAddress(ADDRESS)).toBe(HEX);
    });

    it('returns null for an unlinked holder', async () => {
      accountRepo.findOne.mockResolvedValue({ address: ADDRESS, links: {} });
      expect(await service.getPubkeyForAddress(ADDRESS)).toBeNull();
    });

    it('returns null for a malformed nostr link', async () => {
      accountRepo.findOne.mockResolvedValue({
        address: ADDRESS,
        links: { [PROVIDER]: 'not-a-pubkey' },
      });
      expect(await service.getPubkeyForAddress(ADDRESS)).toBeNull();
    });

    it('serves a second lookup from cache (no second DB read)', async () => {
      accountRepo.findOne.mockResolvedValue({
        address: ADDRESS,
        links: { [PROVIDER]: HEX },
      });
      await service.getPubkeyForAddress(ADDRESS);
      await service.getPubkeyForAddress(ADDRESS);
      expect(accountRepo.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAddressForPubkey', () => {
    it('resolves a hex input to the linked address', async () => {
      qb.getMany.mockResolvedValue([
        { address: ADDRESS, links: { [PROVIDER]: HEX } },
      ]);
      expect(await service.getAddressForPubkey(HEX)).toBe(ADDRESS);
    });

    it('resolves an npub input to the same address as its hex', async () => {
      qb.getMany.mockResolvedValue([
        { address: ADDRESS, links: { [PROVIDER]: HEX } },
      ]);
      expect(await service.getAddressForPubkey(NPUB)).toBe(ADDRESS);
    });

    it('matches a candidate stored as npub against a hex query', async () => {
      qb.getMany.mockResolvedValue([
        { address: ADDRESS2, links: { [PROVIDER]: NPUB } },
      ]);
      expect(await service.getAddressForPubkey(HEX)).toBe(ADDRESS2);
    });

    it('returns null for an unknown pubkey', async () => {
      qb.getMany.mockResolvedValue([]);
      expect(await service.getAddressForPubkey(HEX)).toBeNull();
    });

    it('returns null for an unparseable pubkey input', async () => {
      expect(await service.getAddressForPubkey('garbage')).toBeNull();
      expect(accountRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('onLinkChanged (link handler)', () => {
    it('sets member_pubkey and does NOT re-emit (avoids handler loop)', async () => {
      accountRepo.findOne.mockResolvedValue({
        address: ADDRESS,
        links: { [PROVIDER]: HEX },
      });
      await service.onLinkChanged({ address: ADDRESS });

      expect(membershipRepo.update).toHaveBeenCalledWith(
        { member_address: ADDRESS },
        { member_pubkey: HEX },
      );
      // The originating event already reached Task 06; re-emitting would loop.
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('nulls member_pubkey on unlink (links no longer has the provider)', async () => {
      accountRepo.findOne.mockResolvedValue({ address: ADDRESS, links: {} });
      await service.onLinkChanged({ address: ADDRESS });

      expect(membershipRepo.update).toHaveBeenCalledWith(
        { member_address: ADDRESS },
        { member_pubkey: null },
      );
    });

    it('ignores an empty payload', async () => {
      await service.onLinkChanged({ address: '' });
      expect(membershipRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('reresolveAddress (direct caller)', () => {
    it('emits tgr.link.changed when called directly (default emit=true)', async () => {
      accountRepo.findOne.mockResolvedValue({
        address: ADDRESS,
        links: { [PROVIDER]: HEX },
      });
      await service.reresolveAddress(ADDRESS);

      expect(membershipRepo.update).toHaveBeenCalledWith(
        { member_address: ADDRESS },
        { member_pubkey: HEX },
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(TGR_LINK_CHANGED, {
        address: ADDRESS,
      });
    });

    it('nulls member_pubkey + emits on a direct unlink correction', async () => {
      accountRepo.findOne.mockResolvedValue({ address: ADDRESS, links: {} });
      await service.reresolveAddress(ADDRESS);

      expect(membershipRepo.update).toHaveBeenCalledWith(
        { member_address: ADDRESS },
        { member_pubkey: null },
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(TGR_LINK_CHANGED, {
        address: ADDRESS,
      });
    });
  });

  describe('unlinked-but-eligible invariant (§6.6)', () => {
    it('never writes a malformed pubkey — nulls member_pubkey instead', async () => {
      accountRepo.findOne.mockResolvedValue({
        address: ADDRESS,
        links: { [PROVIDER]: 'deadbeef' }, // wrong length → unparseable
      });
      await service.reresolveAddress(ADDRESS, { emit: false });

      // member_pubkey set to null (not the malformed value), eligibility/
      // relay_state untouched (this service writes neither).
      expect(membershipRepo.update).toHaveBeenCalledWith(
        { member_address: ADDRESS },
        { member_pubkey: null },
      );
      const updateArg = membershipRepo.update.mock.calls[0][1];
      expect(updateArg).not.toHaveProperty('eligible');
      expect(updateArg).not.toHaveProperty('relay_state');
    });
  });

  describe('cache maintenance', () => {
    it('re-link to a new pubkey drops the stale reverse entry', () => {
      const HEX2 = 'b'.repeat(64);
      service.setCacheEntry(ADDRESS, HEX);
      service.setCacheEntry(ADDRESS, HEX2);
      // Reverse lookup for the old hex must no longer resolve via cache.
      expect((service as any).pubkeyToAddress.get(HEX)).toBeUndefined();
      expect((service as any).pubkeyToAddress.get(HEX2)).toBe(ADDRESS);
    });

    it('clearCacheEntry removes both directions', () => {
      service.setCacheEntry(ADDRESS, HEX);
      service.clearCacheEntry(ADDRESS);
      expect(service.cacheSize).toBe(0);
      expect((service as any).pubkeyToAddress.get(HEX)).toBeUndefined();
    });
  });
});
