import { NotFoundException } from '@nestjs/common';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn(),
  paginateRaw: jest.fn(),
}));

import { paginate, paginateRaw } from 'nestjs-typeorm-paginate';
import { RoomsQueryService } from './rooms-query.service';

const paginateRawMock = paginateRaw as jest.Mock;
const paginateMock = paginate as jest.Mock;

const ADDR = 'ak_member';
const SALE = 'ct_sale';

/** A QB stub that records the chain and returns itself for fluent calls. */
function fakeQb() {
  const qb: any = {};
  for (const m of [
    'innerJoin',
    'where',
    'andWhere',
    'select',
    'orderBy',
    'addOrderBy',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  return qb;
}

describe('RoomsQueryService', () => {
  let roomRepo: any;
  let membershipRepo: any;
  let service: RoomsQueryService;

  // a valid bech32 nsec (secret = 32 bytes of 0x01) for the config test; the
  // service must derive the pubkey hex from it and NEVER echo the nsec back.
  const NSEC =
    'nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw';
  const EXPECTED_PUB =
    '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f';

  beforeEach(() => {
    paginateRawMock.mockReset();
    paginateMock.mockReset();
    roomRepo = { findOne: jest.fn() };
    membershipRepo = { createQueryBuilder: jest.fn(() => fakeQb()) };
    service = new RoomsQueryService(roomRepo, membershipRepo, {
      nostrRelayUrl: 'ws://relay.local',
      nostrBotNsec: NSEC,
    } as any);
  });

  describe('listEligibleRooms', () => {
    it('maps raw rows to DTOs and derives readable for an added+linked member', async () => {
      paginateRawMock.mockResolvedValue({
        items: [
          {
            sale_address: SALE,
            token_address: 'ct_token',
            symbol: 'WORDS',
            is_private: true,
            min_token_threshold: '1000',
            is_community: false,
            role: 'member',
            relay_state: 'added',
            member_pubkey: 'a'.repeat(64),
          },
        ],
        meta: { totalItems: 1 },
      } as any);

      const res = await service.listEligibleRooms(ADDR, 1, 100);
      expect(res.items[0]).toEqual({
        sale_address: SALE,
        token_address: 'ct_token',
        symbol: 'WORDS',
        is_private: true,
        min_token_threshold: '1000',
        is_community: false,
        role: 'member',
        relay_state: 'added',
        member_pubkey: 'a'.repeat(64),
        readable: true,
      });
    });

    it('§6.6 unlinked-eligible case → readable=false (pubkey null / pending_add)', async () => {
      paginateRawMock.mockResolvedValue({
        items: [
          {
            sale_address: SALE,
            token_address: 'ct_token',
            symbol: 'WORDS',
            is_private: true,
            min_token_threshold: null,
            is_community: false,
            role: 'member',
            relay_state: 'pending_add',
            member_pubkey: null,
          },
        ],
        meta: { totalItems: 1 },
      } as any);

      const res = await service.listEligibleRooms(ADDR, 1, 100);
      expect(res.items[0].readable).toBe(false);
      expect(res.items[0].member_pubkey).toBeNull();
      // null threshold normalizes to "0"
      expect(res.items[0].min_token_threshold).toBe('0');
    });

    it('added but pubkey null → readable=false', async () => {
      paginateRawMock.mockResolvedValue({
        items: [
          {
            sale_address: SALE,
            token_address: 'ct_token',
            symbol: 'WORDS',
            is_private: false,
            min_token_threshold: '0',
            is_community: false,
            role: 'member',
            relay_state: 'added',
            member_pubkey: null,
          },
        ],
        meta: { totalItems: 1 },
      } as any);
      const res = await service.listEligibleRooms(ADDR, 1, 100);
      expect(res.items[0].readable).toBe(false);
    });

    it('filters to eligible + non-deleted for the given address', async () => {
      const qb = fakeQb();
      membershipRepo.createQueryBuilder.mockReturnValue(qb);
      paginateRawMock.mockResolvedValue({ items: [], meta: {} } as any);
      await service.listEligibleRooms(ADDR, 1, 100);
      expect(qb.where).toHaveBeenCalledWith('rm.member_address = :address', {
        address: ADDR,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('rm.eligible = true');
      expect(qb.andWhere).toHaveBeenCalledWith('cr.deleted = false');
      expect(paginateRawMock).toHaveBeenCalledWith(qb, { page: 1, limit: 100 });
    });
  });

  describe('listRoomMembers', () => {
    it('throws 404 when the room is unknown', async () => {
      roomRepo.findOne.mockResolvedValue(null);
      await expect(
        service.listRoomMembers(SALE, 1, 100),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('defaults to the added (readable) set and maps without a balance field', async () => {
      roomRepo.findOne.mockResolvedValue({ sale_address: SALE });
      const qb = fakeQb();
      membershipRepo.createQueryBuilder.mockReturnValue(qb);
      paginateMock.mockResolvedValue({
        items: [
          {
            member_address: ADDR,
            member_pubkey: 'b'.repeat(64),
            role: 'member',
            relay_state: 'added',
            eligible: true,
          },
        ],
        meta: { totalItems: 1 },
      } as any);

      const res = await service.listRoomMembers(SALE, 1, 100);
      expect(qb.andWhere).toHaveBeenCalledWith('rm.relay_state = :added', {
        added: 'added',
      });
      expect(res.items[0]).toEqual({
        member_address: ADDR,
        member_pubkey: 'b'.repeat(64),
        role: 'member',
        relay_state: 'added',
        eligible: true,
      });
      expect(res.items[0]).not.toHaveProperty('balance');
    });

    it('include_pending=true drops the relay_state filter', async () => {
      roomRepo.findOne.mockResolvedValue({ sale_address: SALE });
      const qb = fakeQb();
      membershipRepo.createQueryBuilder.mockReturnValue(qb);
      paginateMock.mockResolvedValue({ items: [], meta: {} } as any);
      await service.listRoomMembers(SALE, 1, 100, true);
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'rm.relay_state = :added',
        expect.anything(),
      );
    });

    it('maps a null member_pubkey to null', async () => {
      roomRepo.findOne.mockResolvedValue({ sale_address: SALE });
      membershipRepo.createQueryBuilder.mockReturnValue(fakeQb());
      paginateMock.mockResolvedValue({
        items: [
          {
            member_address: ADDR,
            member_pubkey: undefined,
            role: 'admin',
            relay_state: 'added',
            eligible: true,
          },
        ],
        meta: {},
      } as any);
      const res = await service.listRoomMembers(SALE, 1, 100);
      expect(res.items[0].member_pubkey).toBeNull();
    });
  });

  describe('getRoomConfig', () => {
    it('returns the configured relay_url and the derived hex admin_pubkey', () => {
      const cfg = service.getRoomConfig();
      expect(cfg.relay_url).toBe('ws://relay.local');
      expect(cfg.admin_pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(cfg.admin_pubkey).toBe(EXPECTED_PUB);
    });

    it('never returns the nsec', () => {
      const cfg = service.getRoomConfig();
      expect(cfg.admin_pubkey).not.toContain('nsec');
      expect(JSON.stringify(cfg)).not.toContain(NSEC);
    });

    it('returns empty pubkey when no nsec is configured (main without secret)', () => {
      const svc = new RoomsQueryService(roomRepo, membershipRepo, {
        nostrRelayUrl: 'ws://relay.local',
        nostrBotNsec: undefined,
      } as any);
      expect(svc.getRoomConfig().admin_pubkey).toBe('');
    });
  });
});
