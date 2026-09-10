import {
  AccountService,
  CHAIN_NAME_SWEEP_MS,
  CHAIN_NAME_STALE_MS,
} from './account.service';
import { DataSource } from 'typeorm';
import { fetchJson, FetchJsonHttpError } from '@/utils/common';
import { Account } from '../entities/account.entity';

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
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  });

  const createService = () => {
    const queryBuilder = createQueryBuilder();
    const accountRepository = {
      createQueryBuilder: jest.fn(() => queryBuilder),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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

  describe('refreshChainNamesPeriodically', () => {
    beforeEach(() => {
      (fetchJson as jest.Mock).mockReset();
    });

    // Executes the Brackets callbacks the sweep passes to where()/andWhere() so
    // the predicate can be asserted without a database or emitted-SQL matching.
    const collectPredicates = (queryBuilder: any): string[] => {
      const clauses: string[] = [];
      const recorder: any = {
        where: (clause: string) => {
          clauses.push(clause);
          return recorder;
        },
        orWhere: (clause: string) => {
          clauses.push(clause);
          return recorder;
        },
      };
      for (const [brackets] of [
        ...queryBuilder.where.mock.calls,
        ...queryBuilder.andWhere.mock.calls,
      ]) {
        brackets.whereFactory(recorder);
      }
      return clauses;
    };

    // The sweep window and the read path's staleness window are a pair: the
    // sweep has to refresh a name before AccountsController calls it stale, or
    // every read falls through to a live middleware lookup.
    it('sweeps before the read path treats a name as stale', () => {
      expect(CHAIN_NAME_SWEEP_MS).toBeLessThan(CHAIN_NAME_STALE_MS);
    });

    // Asserted as emitted SQL, not builder calls, so equivalent rewrites don't
    // churn the test.
    it('emits the intended sweep SQL', async () => {
      const dataSource = new DataSource({
        type: 'postgres',
        entities: [Account],
      });
      // Builds entity metadata without a connection, so this runs in the plain
      // unit suite (protected API -- a typeorm bump will break this).
      await (dataSource as any).buildMetadatas();
      const entityRepository = dataSource.getRepository(Account);

      let sql = '';
      let params: Record<string, any> = {};
      const accountRepository: any = {
        createQueryBuilder: (alias: string) => {
          const qb = entityRepository.createQueryBuilder(alias);
          (qb as any).getMany = async () => {
            sql = qb.getSql();
            params = qb.getParameters();
            return [];
          };
          return qb;
        },
        update: jest.fn(),
      };
      const service = new AccountService(accountRepository, {
        query: jest.fn(),
      } as any);

      await service.refreshChainNamesPeriodically();

      expect(sql.slice(sql.indexOf('FROM'))).toBe(
        'FROM "accounts" "account" WHERE ("account"."chain_name" IS NOT NULL' +
          ' OR "account"."links" <> \'{}\'::jsonb) AND' +
          ' ("account"."chain_name_checked_at" IS NULL OR' +
          ' "account"."chain_name_checked_at" < $1) ORDER BY' +
          ' "account"."chain_name_checked_at" ASC NULLS FIRST LIMIT 100',
      );

      // The threshold only ever reaches SQL as $1, so a sign flip (a window in
      // the future, sweeping every row every hour) is invisible above.
      const threshold: Date = params.staleThreshold;
      expect(threshold.getTime()).toBeLessThanOrEqual(
        Date.now() - CHAIN_NAME_SWEEP_MS,
      );
      expect(threshold.getTime()).toBeGreaterThan(
        Date.now() - CHAIN_NAME_SWEEP_MS - 60_000,
      );
    });

    it('writes a name resolved for a linked account that never had one', async () => {
      const { service, accountRepository, queryBuilder } = createService();
      queryBuilder.getMany.mockResolvedValue([
        { address: 'ak_alice', chain_name: null, links: { x: 'alice' } },
      ]);
      (fetchJson as jest.Mock).mockImplementation(async (url: string) =>
        url.includes('/names/pointees')
          ? {
              data: [
                {
                  active: true,
                  name: 'alice.chain',
                  block_height: 5,
                  block_time: 1,
                  tx: { pointers: [{ id: 'ak_alice' }] },
                },
              ],
            }
          : { active: true, pointers: [{ id: 'ak_alice' }] },
      );

      await service.refreshChainNamesPeriodically();

      // The linked-account clause is what puts ak_alice in the batch at all;
      // without it the sweep only ever sees accounts that already have a name.
      expect(collectPredicates(queryBuilder)).toContain(
        `account.links <> '{}'::jsonb`,
      );
      expect(accountRepository.update).toHaveBeenCalledWith('ak_alice', {
        chain_name: 'alice.chain',
        chain_name_updated_at: expect.any(Date),
        chain_name_checked_at: expect.any(Date),
      });
    });

    // The null/undefined split is the subtlest rule here: null is a verified
    // absence and is written, while undefined means the lookup failed and a
    // good name must survive. Both stamp the attempt, or a row that always
    // fails would retake a queue slot every hour forever.
    it('stamps a verified absence but preserves the name when the fetch fails', async () => {
      const { service, accountRepository, queryBuilder } = createService();
      queryBuilder.getMany.mockResolvedValue([
        { address: 'ak_none', chain_name: null, links: { x: 'n' } },
        { address: 'ak_kept', chain_name: 'kept.chain', links: {} },
      ]);
      (fetchJson as jest.Mock).mockImplementation(async (url: string) => {
        if (url.includes('ak_kept')) {
          throw new Error('middleware 500');
        }
        return { data: [] };
      });

      await service.refreshChainNamesPeriodically();

      expect(accountRepository.update).toHaveBeenCalledWith('ak_none', {
        chain_name: null,
        chain_name_updated_at: expect.any(Date),
        chain_name_checked_at: expect.any(Date),
      });
      expect(accountRepository.update).toHaveBeenCalledWith('ak_kept', {
        chain_name_checked_at: expect.any(Date),
      });
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

  describe('ensureAccountFromChain', () => {
    const ADDRESS = 'ak_3yT4BoLMWVWtCEpbb3Sv3ArtetmR5kVMDANpFsezXpqHBiFGQ';

    beforeEach(() => {
      (fetchJson as jest.Mock).mockReset();
    });

    it('persists and returns a minimal row when the node knows the account', async () => {
      const { service, accountRepository } = createService();
      const stored = { address: ADDRESS };
      (fetchJson as jest.Mock).mockResolvedValue({
        id: ADDRESS,
        balance: '100067982528000000000',
      });
      accountRepository.findOne.mockResolvedValue(stored);

      const result = await service.ensureAccountFromChain(ADDRESS);

      expect(fetchJson).toHaveBeenCalledWith(
        expect.stringContaining(`/v3/accounts/${ADDRESS}`),
      );
      expect(accountRepository.upsert).toHaveBeenCalledWith(
        { address: ADDRESS },
        expect.objectContaining({ conflictPaths: ['address'] }),
      );
      expect(result).toBe(stored);
    });

    it('returns null without persisting when the node 404s', async () => {
      const { service, accountRepository } = createService();
      (fetchJson as jest.Mock).mockRejectedValue(
        new FetchJsonHttpError('Account not found', 404),
      );

      const result = await service.ensureAccountFromChain(ADDRESS);

      expect(result).toBeNull();
      expect(accountRepository.upsert).not.toHaveBeenCalled();
    });

    it('propagates non-404 fetch errors instead of creating a row', async () => {
      const { service, accountRepository } = createService();
      (fetchJson as jest.Mock).mockRejectedValue(
        new FetchJsonHttpError('Bad gateway', 502),
      );

      await expect(service.ensureAccountFromChain(ADDRESS)).rejects.toThrow(
        'Bad gateway',
      );
      expect(accountRepository.upsert).not.toHaveBeenCalled();
    });
  });
});
