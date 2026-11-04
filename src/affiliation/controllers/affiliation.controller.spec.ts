import { ConflictException, NotFoundException } from '@nestjs/common';
import { Affiliation } from '../entities/affiliation.entity';
import { AffiliationCode } from '../entities/affiliation-code.entity';
import {
  AffiliationController,
  INVITE_CLAIM_LOCK_KEY,
} from './affiliation.controller';

describe('AffiliationController', () => {
  let controller: AffiliationController;
  let affiliation: any;
  let claimedCode: any;
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let oauthService: {
    verifyAccessToken: jest.Mock;
  };

  beforeEach(() => {
    affiliation = null;
    claimedCode = null;
    manager = {
      query: jest.fn(),
      findOne: jest.fn(async (entity) =>
        entity === Affiliation ? affiliation : claimedCode,
      ),
      update: jest.fn(),
    };
    oauthService = {
      verifyAccessToken: jest.fn().mockResolvedValue({ id: 'user-1' }),
    };

    controller = new AffiliationController(
      {} as any,
      { manager: { transaction: (work) => work(manager) } } as any,
      oauthService as any,
    );
  });

  describe('getRewardCode', () => {
    it('throws ConflictException when the user already claimed a code on another link', async () => {
      affiliation = {
        code: 'code',
        codes: [{ id: 2, private_code: 'sk_2' }],
      };
      claimedCode = { id: 1, private_code: 'sk_1', claimed_at: new Date() };

      await expect(
        controller.getRewardCode('code', 'github', 'token'),
      ).rejects.toThrow(ConflictException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the affiliation does not exist', async () => {
      await expect(
        controller.getRewardCode('code', 'github', 'token'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when no unclaimed codes remain', async () => {
      affiliation = {
        code: 'code',
        codes: [{ id: 1, claimed_at: new Date() }],
      };

      await expect(
        controller.getRewardCode('code', 'github', 'token'),
      ).rejects.toThrow(ConflictException);
    });

    it('takes the claim lock before reading anything', async () => {
      affiliation = { code: 'code', codes: [{ id: 1, private_code: 'sk_1' }] };

      await controller.getRewardCode('code', 'github', 'token');

      expect(manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock($1)',
        [INVITE_CLAIM_LOCK_KEY],
      );
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        manager.findOne.mock.invocationCallOrder[0],
      );
    });

    it('stamps claimed_by and claimed_at on the code it hands out', async () => {
      affiliation = { code: 'code', codes: [{ id: 1, private_code: 'sk_1' }] };

      const result = await controller.getRewardCode('code', 'GitHub', 'token');

      expect(result).toEqual({
        affiliation: { code: 'code', available_codes: 1 },
        invitationCode: { private_code: 'sk_1' },
      });
      expect(manager.update).toHaveBeenCalledWith(AffiliationCode, 1, {
        claimed_by: 'github@user-1',
        claimed_at: expect.any(Date),
      });
    });

    it('never hands out a code that is already assigned to someone', async () => {
      affiliation = {
        code: 'code',
        codes: [
          { id: 1, private_code: 'sk_1', claimed_by: 'x@someone-else' },
          { id: 2, private_code: 'sk_2' },
        ],
      };

      for (let i = 0; i < 20; i++) {
        const result = await controller.getRewardCode('code', 'x', 'token');
        expect(result.invitationCode.private_code).toBe('sk_2');
      }
    });

    it('returns the same code when the user claims on the same link again', async () => {
      const code = {
        id: 1,
        private_code: 'sk_1',
        claimed_by: 'github@user-1',
        claimed_at: new Date(),
      };
      affiliation = {
        code: 'code',
        codes: [code, { id: 2, private_code: 'sk_2' }],
      };
      claimedCode = code;

      const result = await controller.getRewardCode('code', 'github', 'token');

      expect(result).toEqual({
        affiliation: { code: 'code', available_codes: 1 },
        invitationCode: { private_code: 'sk_1' },
      });
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});
