import { BadRequestException } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsQueryService } from '../services/rooms-query.service';
import { RoomMuteService } from '../services/room-mute.service';
import { DeviceChallengeService } from '@/notifications/services/device-challenge.service';

const ADDR = 'ak_member';
const SALE = 'ct_sale';

describe('RoomsController', () => {
  let rooms: jest.Mocked<
    Pick<
      RoomsQueryService,
      'listEligibleRooms' | 'listRoomMembers' | 'getRoomConfig'
    >
  >;
  let mute: jest.Mocked<Pick<RoomMuteService, 'getMute' | 'setMute'>>;
  let challenges: jest.Mocked<
    Pick<DeviceChallengeService, 'issue' | 'verifyAndConsumeForRoomMute'>
  >;
  let controller: RoomsController;

  beforeEach(() => {
    rooms = {
      listEligibleRooms: jest.fn(),
      listRoomMembers: jest.fn(),
      getRoomConfig: jest.fn(),
    } as any;
    mute = { getMute: jest.fn(), setMute: jest.fn() } as any;
    challenges = {
      issue: jest.fn(),
      verifyAndConsumeForRoomMute: jest.fn(),
    } as any;
    controller = new RoomsController(
      rooms as any,
      mute as any,
      challenges as any,
    );
  });

  describe('validatePagination (via listEligibleRooms)', () => {
    it('rejects page < 1', async () => {
      await expect(
        controller.listEligibleRooms(ADDR, 0, 100),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects limit < 1', async () => {
      await expect(
        controller.listEligibleRooms(ADDR, 1, 0),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects limit > 100', async () => {
      await expect(
        controller.listEligibleRooms(ADDR, 1, 101),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts default page=1 limit=100 and delegates', async () => {
      rooms.listEligibleRooms.mockResolvedValue({ items: [], meta: {} } as any);
      await controller.listEligibleRooms(ADDR, 1, 100);
      expect(rooms.listEligibleRooms).toHaveBeenCalledWith(ADDR, 1, 100);
    });
  });

  describe('listRoomMembers', () => {
    it('passes include_pending through and validates pagination', async () => {
      rooms.listRoomMembers.mockResolvedValue({ items: [], meta: {} } as any);
      await controller.listRoomMembers(SALE, 1, 50, true);
      expect(rooms.listRoomMembers).toHaveBeenCalledWith(SALE, 1, 50, true);
    });

    it('rejects bad pagination', async () => {
      await expect(
        controller.listRoomMembers(SALE, 1, 999, false),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getRoomConfig', () => {
    it('delegates to the query service', () => {
      rooms.getRoomConfig.mockReturnValue({
        relay_url: 'ws://r',
        admin_pubkey: 'a'.repeat(64),
      });
      expect(controller.getRoomConfig()).toEqual({
        relay_url: 'ws://r',
        admin_pubkey: 'a'.repeat(64),
      });
    });
  });

  describe('requestRoomMuteChallenge', () => {
    it('delegates to the shared challenge service', async () => {
      challenges.issue.mockResolvedValue({
        nonce: 'n',
        expiresAt: new Date(),
      });
      await controller.requestRoomMuteChallenge({ address: ADDR });
      expect(challenges.issue).toHaveBeenCalledWith(ADDR);
    });
  });

  describe('getRoomMute', () => {
    it('delegates to the mute service', async () => {
      mute.getMute.mockResolvedValue({ muted: true, mute_all: false });
      expect(await controller.getRoomMute(SALE, ADDR)).toEqual({
        muted: true,
        mute_all: false,
      });
      expect(mute.getMute).toHaveBeenCalledWith(ADDR, SALE);
    });
  });

  describe('setRoomMute', () => {
    it('verifies the signed challenge BEFORE writing, then sets the mute', async () => {
      mute.setMute.mockResolvedValue({ muted: true, mute_all: true });
      const dto = {
        address: ADDR,
        nonce: 'n',
        signature: 'sg_x',
        muted: true,
        mute_all: true,
      };
      const result = await controller.setRoomMute(SALE, dto as any);
      expect(challenges.verifyAndConsumeForRoomMute).toHaveBeenCalledWith(
        'n',
        ADDR,
        SALE,
        true,
        true,
        'sg_x',
      );
      expect(mute.setMute).toHaveBeenCalledWith(ADDR, SALE, true, true);
      expect(result).toEqual({ muted: true, mute_all: true });
    });

    it('does not write when verification throws', async () => {
      challenges.verifyAndConsumeForRoomMute.mockRejectedValue(
        new BadRequestException('Challenge already used'),
      );
      const dto = {
        address: ADDR,
        nonce: 'n',
        signature: 'sg_x',
        muted: true,
      };
      await expect(
        controller.setRoomMute(SALE, dto as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mute.setMute).not.toHaveBeenCalled();
    });
  });
});
