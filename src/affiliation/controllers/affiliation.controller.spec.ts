import { ConflictException, NotFoundException } from '@nestjs/common';
import { AffiliationController } from './affiliation.controller';

describe('AffiliationController', () => {
  let controller: AffiliationController;
  let affiliationRepository: {
    findOne: jest.Mock;
  };
  let affiliationCodeRepository: {
    findOne: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
  let oauthService: {
    verifyAccessToken: jest.Mock;
  };

  beforeEach(() => {
    affiliationRepository = {
      findOne: jest.fn(),
    };
    affiliationCodeRepository = {
      findOne: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    };
    oauthService = {
      verifyAccessToken: jest.fn().mockResolvedValue({ id: 'user-1' }),
    };

    controller = new AffiliationController(
      affiliationRepository as any,
      affiliationCodeRepository as any,
      oauthService as any,
    );
  });

  describe('getRewardCode', () => {
    it('throws ConflictException when the user already claimed a code', async () => {
      affiliationCodeRepository.findOne.mockResolvedValue({
        id: 1,
        claimed_at: new Date(),
      });

      await expect(
        controller.getRewardCode('code', 'github', 'token'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when the affiliation does not exist', async () => {
      affiliationCodeRepository.findOne.mockResolvedValue(null);
      affiliationRepository.findOne.mockResolvedValue(null);

      await expect(
        controller.getRewardCode('code', 'github', 'token'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when no unclaimed codes remain', async () => {
      affiliationCodeRepository.findOne.mockResolvedValue(null);
      affiliationRepository.findOne.mockResolvedValue({
        code: 'code',
        codes: [{ id: 1, claimed_at: new Date() }],
      });

      await expect(
        controller.getRewardCode('code', 'github', 'token'),
      ).rejects.toThrow(ConflictException);
    });
  });
});
