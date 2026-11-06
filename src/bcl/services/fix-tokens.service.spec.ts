import { Logger } from '@nestjs/common';
import { FixTokensService } from './fix-tokens.service';

describe('FixTokensService', () => {
  let service: FixTokensService;
  let tokensRepository: any;
  let tokensService: any;
  let queryBuilder: any;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    tokensRepository = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };
    tokensService = {
      getTokenAex9Address: jest.fn(),
      syncTokenPrice: jest.fn(),
    };
    service = new FixTokensService(tokensRepository, tokensService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('fixTokensAddresses', () => {
    it('keeps a token whose AEX9 lookup fails and resolves the rest', async () => {
      const failing = { sale_address: 'ct_failing' };
      const healthy = { sale_address: 'ct_healthy' };
      tokensRepository.find.mockResolvedValue([failing, healthy]);
      tokensService.getTokenAex9Address
        .mockRejectedValueOnce(new Error('node timeout'))
        .mockResolvedValueOnce('ct_aex9');

      await service.fixTokensAddresses();

      expect(tokensService.getTokenAex9Address).toHaveBeenCalledWith(failing);
      expect(tokensService.getTokenAex9Address).toHaveBeenCalledWith(healthy);
      expect(tokensRepository.delete).not.toHaveBeenCalled();
    });

    it('runs again after the token query fails', async () => {
      tokensRepository.find.mockRejectedValueOnce(new Error('pool timeout'));

      await expect(service.fixTokensAddresses()).resolves.toBeUndefined();
      await service.fixTokensAddresses();

      expect(tokensRepository.find).toHaveBeenCalledTimes(2);
    });

    it('skips a run while another is in flight', async () => {
      let finish: (tokens: unknown[]) => void;
      tokensRepository.find.mockReturnValueOnce(
        new Promise((resolve) => (finish = resolve)),
      );

      const first = service.fixTokensAddresses();
      await service.fixTokensAddresses();
      finish([]);
      await first;

      expect(tokensRepository.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('fixTokensWithNoPrice', () => {
    it('runs again after the token query fails', async () => {
      const token = { sale_address: 'ct_sale' };
      queryBuilder.getMany
        .mockRejectedValueOnce(new Error('pool timeout'))
        .mockResolvedValueOnce([token]);

      // onModuleInit fires this unawaited, so a rejection would exit the process.
      await expect(service.fixTokensWithNoPrice()).resolves.toBeUndefined();
      await service.fixTokensWithNoPrice();

      expect(tokensService.syncTokenPrice).toHaveBeenCalledWith(token);
    });
  });
});
