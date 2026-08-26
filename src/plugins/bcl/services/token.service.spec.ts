import { TokenService } from './token.service';
import { Token } from '@/tokens/entities/token.entity';

describe('TokenService (bcl plugin)', () => {
  const createService = () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    const tokensRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      query: jest.fn(),
    };
    const service = new TokenService(
      tokensRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, tokensRepository, queryBuilder };
  };

  describe('findByAddress', () => {
    it('returns the persisted rank without a second query', async () => {
      const { service, tokensRepository, queryBuilder } = createService();
      queryBuilder.getOne.mockResolvedValue({
        sale_address: 'ct_sale',
        factory_address: 'ct_factory',
        rank: 42,
      } as Token);

      const token = await service.findByAddress('ct_sale');

      expect(token?.rank).toBe(42);
      // A RANK() OVER (...) recompute here scanned every token of the factory
      // on the indexer's hot path: 135ms against 63k tokens, for a value no
      // caller on this path reads.
      expect(tokensRepository.query).not.toHaveBeenCalled();
      expect(tokensRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('returns null when no token matches', async () => {
      const { service, tokensRepository, queryBuilder } = createService();
      queryBuilder.getOne.mockResolvedValue(null);

      await expect(service.findByAddress('ct_missing')).resolves.toBeNull();
      expect(tokensRepository.query).not.toHaveBeenCalled();
    });

    it('reads through the transaction manager when one is given', async () => {
      const { service, tokensRepository, queryBuilder } = createService();
      const managerQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValue({ sale_address: 'ct_sale' } as Token),
      };
      const manager: any = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(managerQueryBuilder),
        }),
      };

      await service.findByAddress('ct_sale', manager);

      expect(manager.getRepository).toHaveBeenCalledWith(Token);
      expect(managerQueryBuilder.getOne).toHaveBeenCalledTimes(1);
      expect(queryBuilder.getOne).not.toHaveBeenCalled();
      expect(tokensRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
