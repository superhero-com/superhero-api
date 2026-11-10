import { Logger } from '@nestjs/common';
import BigNumber from 'bignumber.js';
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
      update: jest.fn().mockResolvedValue(undefined),
    };
    const tokensService = { getTokeLivePrice: jest.fn() };
    const service = new TokenService(
      tokensRepository as any,
      tokensService as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, tokensRepository, tokensService, queryBuilder };
  };

  describe('findByAddress', () => {
    it('returns the token row without a rank query', async () => {
      const { service, tokensRepository, queryBuilder } = createService();
      queryBuilder.getOne.mockResolvedValue({
        sale_address: 'ct_sale',
        factory_address: 'ct_factory',
      } as Token);

      const token = await service.findByAddress('ct_sale');

      expect(token?.sale_address).toBe('ct_sale');
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

  describe('refreshTokenPrice', () => {
    const token = { sale_address: 'ct_sale' } as Token;
    const flush = () => new Promise(setImmediate);

    afterEach(() => jest.restoreAllMocks());

    const deferred = <T>() => {
      let resolve: (value: T) => void = () => undefined;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };

    it('writes the defined live values through the repository', async () => {
      const { service, tokensRepository, tokensService } = createService();
      const price = new BigNumber(2);
      tokensService.getTokeLivePrice.mockResolvedValue({
        price,
        name: undefined,
      });

      await service.refreshTokenPrice(token);

      expect(tokensService.getTokeLivePrice).toHaveBeenCalledWith(token);
      expect(tokensRepository.update).toHaveBeenCalledWith('ct_sale', {
        price,
      });
    });

    it('serves requests made during a refresh with one later run', async () => {
      const { service, tokensService, tokensRepository } = createService();
      const first = deferred<any>();
      const second = deferred<any>();
      tokensService.getTokeLivePrice
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      const done: string[] = [];
      const a = service.refreshTokenPrice(token).then(() => done.push('a'));
      const b = service.refreshTokenPrice(token).then(() => done.push('b'));
      const c = service.refreshTokenPrice(token).then(() => done.push('c'));
      await flush();

      expect(tokensService.getTokeLivePrice).toHaveBeenCalledTimes(1);

      first.resolve({ price: new BigNumber(1) });
      await flush();

      // b and c asked while the first run was reading the chain, so they wait
      // for a run that starts after them.
      expect(done).toEqual(['a']);
      expect(tokensService.getTokeLivePrice).toHaveBeenCalledTimes(2);

      second.resolve({ price: new BigNumber(3) });
      await Promise.all([a, b, c]);

      expect(done).toEqual(['a', 'b', 'c']);
      expect(tokensService.getTokeLivePrice).toHaveBeenCalledTimes(2);
      expect(tokensRepository.update).toHaveBeenLastCalledWith('ct_sale', {
        price: new BigNumber(3),
      });
    });

    it('starts a fresh run for every request after the previous ones end', async () => {
      const { service, tokensService } = createService();
      tokensService.getTokeLivePrice.mockResolvedValue({
        price: new BigNumber(1),
      });

      for (let i = 0; i < 3; i++) {
        await service.refreshTokenPrice(token);
        await flush();
      }

      expect(tokensService.getTokeLivePrice).toHaveBeenCalledTimes(3);
    });

    it('refreshes different tokens in parallel', async () => {
      const { service, tokensService } = createService();
      tokensService.getTokeLivePrice.mockReturnValue(deferred<any>().promise);

      void service.refreshTokenPrice(token);
      void service.refreshTokenPrice({ sale_address: 'ct_other' } as Token);
      await flush();

      expect(tokensService.getTokeLivePrice).toHaveBeenCalledTimes(2);
    });

    it('resolves on a failed refresh and keeps serving the token', async () => {
      const { service, tokensService, tokensRepository } = createService();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      tokensService.getTokeLivePrice
        .mockRejectedValueOnce(new Error('node down'))
        .mockResolvedValueOnce({ price: new BigNumber(1) });

      await expect(service.refreshTokenPrice(token)).resolves.toBeUndefined();
      await flush();
      await service.refreshTokenPrice(token);

      expect(tokensService.getTokeLivePrice).toHaveBeenCalledTimes(2);
      expect(tokensRepository.update).toHaveBeenCalledTimes(1);
    });
  });
});
