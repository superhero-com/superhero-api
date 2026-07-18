import { AccountService } from './account.service';
import { fetchJson } from '@/utils/common';

jest.mock('@/utils/common', () => {
  const actual = jest.requireActual('@/utils/common');
  return {
    ...actual,
    fetchJson: jest.fn(),
  };
});

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

  describe('getChainNameForAccount', () => {
    const ACCOUNT = 'ak_owner';

    beforeEach(() => {
      (fetchJson as jest.Mock).mockReset();
    });

    it('verifies candidate names in parallel and returns the newest match', async () => {
      const { service } = createService();

      (fetchJson as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/names/pointees')) {
          return Promise.resolve({
            data: [
              {
                active: true,
                name: 'old.chain',
                block_height: 100,
                tx: { pointers: [{ id: ACCOUNT, key: '', encoded_key: '' }] },
              },
              {
                active: true,
                name: 'new.chain',
                block_height: 200,
                tx: { pointers: [{ id: ACCOUNT, key: '', encoded_key: '' }] },
              },
            ],
          });
        }
        // Per-name verification calls
        if (url.includes('old.chain')) {
          return Promise.resolve({
            active: true,
            pointers: [{ id: ACCOUNT }],
          });
        }
        if (url.includes('new.chain')) {
          return Promise.resolve({
            active: true,
            pointers: [{ id: ACCOUNT }],
          });
        }
        return Promise.resolve(null);
      });

      const result = await service.getChainNameForAccount(ACCOUNT);

      expect(result).toBe('new.chain'); // higher block_height wins
      // 1 pointees call + 2 per-name verification calls
      expect(fetchJson).toHaveBeenCalledTimes(3);
      // Per-name verification calls pass a timeout signal
      const verifyCalls = (fetchJson as jest.Mock).mock.calls.filter(([url]) =>
        url.includes('/v3/names/'),
      );
      expect(verifyCalls).toHaveLength(2);
      for (const [, options] of verifyCalls) {
        expect(options?.signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('never exceeds CHAIN_NAME_VERIFY_CONCURRENCY in-flight verification calls for an account with many candidate names', async () => {
      const { service } = createService();
      const CANDIDATE_COUNT = 20;
      // Mirrors the CHAIN_NAME_VERIFY_CONCURRENCY constant in account.service.ts.
      // Kept low deliberately: refreshChainNamesPeriodically already runs 10
      // accounts concurrently, so this value multiplies into the real
      // worst-case outbound fan-out (see the constant's own comment).
      const EXPECTED_MAX_CONCURRENCY = 2;

      let inFlight = 0;
      let peakInFlight = 0;

      (fetchJson as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/names/pointees')) {
          return Promise.resolve({
            data: Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
              active: true,
              name: `name${i}.chain`,
              block_height: i,
              tx: { pointers: [{ id: ACCOUNT, key: '', encoded_key: '' }] },
            })),
          });
        }

        // Per-name verification calls: track how many are in flight at once.
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        return new Promise((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve({ active: true, pointers: [{ id: ACCOUNT }] });
          }, 1);
        });
      });

      await service.getChainNameForAccount(ACCOUNT);

      expect(peakInFlight).toBeLessThanOrEqual(EXPECTED_MAX_CONCURRENCY);
      expect(peakInFlight).toBeGreaterThan(0);
    });

    it('falls back to historical pointer data when the per-name verification call throws', async () => {
      const { service } = createService();

      (fetchJson as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/names/pointees')) {
          return Promise.resolve({
            data: [
              {
                active: true,
                name: 'flaky.chain',
                block_height: 100,
                tx: { pointers: [{ id: ACCOUNT, key: '', encoded_key: '' }] },
              },
            ],
          });
        }
        return Promise.reject(new Error('network timeout'));
      });

      const result = await service.getChainNameForAccount(ACCOUNT);

      expect(result).toBe('flaky.chain');
    });

    it('skips a name whose current state no longer points to the account', async () => {
      const { service } = createService();

      (fetchJson as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/names/pointees')) {
          return Promise.resolve({
            data: [
              {
                active: true,
                name: 'stale.chain',
                block_height: 100,
                tx: { pointers: [{ id: ACCOUNT, key: '', encoded_key: '' }] },
              },
            ],
          });
        }
        // Current state: no longer active
        return Promise.resolve({ active: false, pointers: [{ id: ACCOUNT }] });
      });

      const result = await service.getChainNameForAccount(ACCOUNT);

      expect(result).toBeNull();
    });
  });

  describe('scheduledFullAccountsRebuild', () => {
    it('is a no-op while PULL_ACCOUNTS_ENABLED is false (current config)', async () => {
      const { service } = createService();
      const rebuildSpy = jest.spyOn(service, 'saveAllActiveAccounts');

      await service.scheduledFullAccountsRebuild();

      expect(rebuildSpy).not.toHaveBeenCalled();
    });
  });
});
