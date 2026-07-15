import { AccountService } from './account.service';

describe('AccountService', () => {
  const createQueryBuilder = () => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  });

  const createService = () => {
    const queryBuilder = createQueryBuilder();
    const accountRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      find: jest.fn().mockResolvedValue([]),
    };
    const transactionRepository = {
      query: jest.fn(),
    };

    const service = new AccountService(
      accountRepository as any,
      transactionRepository as any,
    );

    return { service, accountRepository, queryBuilder, transactionRepository };
  };

  describe('searchByNameOrAddress', () => {
    it('returns [] without querying for a missing/blank/too-short term', async () => {
      const { service, accountRepository } = createService();

      expect(await service.searchByNameOrAddress(undefined, 8)).toEqual([]);
      expect(await service.searchByNameOrAddress('   ', 8)).toEqual([]);
      // A single (trimmed) character is below SEARCH_MIN_QUERY_LENGTH: a
      // leading-wildcard ILIKE would seq-scan the whole table for no value.
      expect(await service.searchByNameOrAddress('x', 8)).toEqual([]);
      expect(await service.searchByNameOrAddress('  y  ', 8)).toEqual([]);
      expect(accountRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('builds a parameterized ILIKE query ordered by chain_name presence then total_volume', async () => {
      const { service, accountRepository, queryBuilder } = createService();
      queryBuilder.getMany.mockResolvedValue([
        { address: 'ak_alice', chain_name: 'alice.chain' },
        { address: 'ak_bob', chain_name: null },
      ]);

      const result = await service.searchByNameOrAddress('alice', 8);

      expect(accountRepository.createQueryBuilder).toHaveBeenCalledWith(
        'account',
      );
      expect(queryBuilder.where).toHaveBeenCalled();
      const [, whereParams] = (queryBuilder.where as jest.Mock).mock.calls[0];
      // Brackets callback is opaque here; assert via the actual bracket qb below.
      expect(whereParams).toBeUndefined();

      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        '(account.chain_name IS NOT NULL)',
        'DESC',
      );
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith(
        'account.total_volume',
        'DESC',
      );
      expect(queryBuilder.limit).toHaveBeenCalledWith(8);
      expect(result).toEqual([
        { address: 'ak_alice', chain_name: 'alice.chain' },
        { address: 'ak_bob', chain_name: null },
      ]);
    });

    it('binds the search term as a parameterized ILIKE pattern (never string-concatenated)', async () => {
      const { service, queryBuilder } = createService();

      await service.searchByNameOrAddress('bob', 8);

      // Inspect what the Brackets callback actually built by invoking it
      // with a fake qb capturing where/orWhere calls.
      const bracketsInstance = (queryBuilder.where as jest.Mock).mock
        .calls[0][0];
      const calls: Array<[string, unknown]> = [];
      const fakeQb = {
        where: (sql: string, params: unknown) => {
          calls.push([sql, params]);
          return fakeQb;
        },
        orWhere: (sql: string, params: unknown) => {
          calls.push([sql, params]);
          return fakeQb;
        },
      };
      bracketsInstance.whereFactory(fakeQb as any);

      expect(calls).toEqual([
        ['account.address ILIKE :term', { term: '%bob%' }],
        ['account.chain_name ILIKE :term', { term: '%bob%' }],
      ]);
    });

    it('clamps limit to the 1-20 range', async () => {
      const { service, queryBuilder } = createService();

      // Use a 2-char term so it clears SEARCH_MIN_QUERY_LENGTH and actually
      // reaches the limit() call.
      await service.searchByNameOrAddress('xy', 0);
      expect(queryBuilder.limit).toHaveBeenLastCalledWith(1);

      await service.searchByNameOrAddress('xy', 999);
      expect(queryBuilder.limit).toHaveBeenLastCalledWith(20);

      await service.searchByNameOrAddress('xy', 8);
      expect(queryBuilder.limit).toHaveBeenLastCalledWith(8);
    });
  });

  describe('getChainNamesForAddresses', () => {
    const ADDR_A = 'ak_3yT4BoLMWVWtCEpbb3Sv3ArtetmR5kVMDANpFsezXpqHBiFGQ';
    const ADDR_B = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
    const ADDR_C = 'ak_2maNN7AsevCiv546m1TLrSxCFSDeVHif7S7pSsdPS2VXEbkbG';

    it('returns {} for an empty input list without querying', async () => {
      const { service, accountRepository } = createService();

      expect(await service.getChainNamesForAddresses([])).toEqual({});
      expect(accountRepository.find).not.toHaveBeenCalled();
    });

    it('maps every requested address, defaulting unknown/no-chain-name to null', async () => {
      const { service, accountRepository } = createService();
      accountRepository.find.mockResolvedValue([
        { address: ADDR_A, chain_name: 'alice.chain' },
        { address: ADDR_B, chain_name: null },
        // ADDR_C intentionally absent -> unknown account
      ]);

      const result = await service.getChainNamesForAddresses([
        ADDR_A,
        ADDR_B,
        ADDR_C,
      ]);

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { address: expect.anything() },
        select: ['address', 'chain_name'],
      });
      expect(result).toEqual({
        [ADDR_A]: 'alice.chain',
        [ADDR_B]: null,
        [ADDR_C]: null,
      });
    });

    it('caps resolution at 25 addresses, ignoring the rest', async () => {
      const { service, accountRepository } = createService();
      const addresses = Array.from({ length: 30 }, (_, i) => `ak_${i}`);
      accountRepository.find.mockResolvedValue([]);

      const result = await service.getChainNamesForAddresses(addresses);

      expect(Object.keys(result)).toHaveLength(25);
      expect(Object.keys(result)).toEqual(addresses.slice(0, 25));
    });
  });
});
