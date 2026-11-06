import { TX_FUNCTIONS } from '@/configs';
import { DEX_CONTRACTS } from '@/dex/config/dex-contracts.config';
import { fetchJson, FetchJsonHttpError } from '@/utils/common';
import routerAci from 'dex-contracts-v2/build/AedexV2Router.aci.json';
import { DexTransactionProcessorService } from './dex-transaction-processor.service';
import mainnetTxs from './__fixtures__/mainnet-router-txs.json';

jest.mock('@/utils/common', () => ({
  ...jest.requireActual('@/utils/common'),
  fetchJson: jest.fn(),
}));

describe('DexTransactionProcessorService', () => {
  const setup = () => {
    const dexTokenRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    } as any;
    const dexPairRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as any;
    const dexPairTransactionRepository = {
      manager: { transaction: jest.fn() },
      createQueryBuilder: jest.fn(),
      delete: jest.fn(),
    } as any;
    const pairService = {
      pullPairData: jest.fn(),
      getFactoryPairAddress: jest.fn(),
      getPairTokens: jest.fn(),
    } as any;
    const dexTokenSummaryService = {
      createOrUpdateSummary: jest.fn().mockResolvedValue(undefined),
    } as any;
    // Enough of a node for Contract.initialize, so events decode for real.
    const aeSdkService = {
      sdk: {
        getContext: () => ({
          onNode: { getContract: async () => ({ active: true }) },
        }),
      },
    } as any;

    const service = new DexTransactionProcessorService(
      dexTokenRepository,
      dexPairRepository,
      dexPairTransactionRepository,
      aeSdkService,
      pairService,
      dexTokenSummaryService,
    );

    return {
      service,
      dexTokenRepository,
      dexPairTransactionRepository,
      dexTokenSummaryService,
      pairService,
    };
  };

  describe('error handling', () => {
    const routerTx = {
      hash: 'th_swap',
      contract_id: DEX_CONTRACTS.router,
      function: TX_FUNCTIONS.swap_exact_tokens_for_tokens,
    } as any;

    it('rethrows when saving the trade fails, so the tx is parked', async () => {
      const { service, dexPairTransactionRepository } = setup();
      jest
        .spyOn(service as any, 'extractPairInfoFromTransaction')
        .mockResolvedValue({ pairAddress: 'ct_pair' });
      dexPairTransactionRepository.manager.transaction.mockRejectedValue(
        new Error('timeout exceeded when trying to connect'),
      );

      await expect(
        service.processTransaction(routerTx, 'live' as any),
      ).rejects.toThrow('timeout exceeded when trying to connect');
    });

    it('still skips transactions that are not DEX router calls', async () => {
      const { service } = setup();

      await expect(
        service.processTransaction(
          { ...routerTx, contract_id: 'ct_other' },
          'live' as any,
        ),
      ).resolves.toBeNull();
    });
  });

  describe('getOrCreateToken', () => {
    beforeEach(() => {
      (fetchJson as jest.Mock).mockReset();
    });

    it('stores a placeholder when the middleware does not know the token', async () => {
      const { service, dexTokenRepository } = setup();
      dexTokenRepository.findOne.mockResolvedValue(null);
      dexTokenRepository.save.mockImplementation(async (token: any) => token);
      (fetchJson as jest.Mock).mockRejectedValue(
        new FetchJsonHttpError('not found', 404),
      );
      jest.spyOn((service as any).logger, 'error').mockImplementation();

      const token = await (service as any).getOrCreateToken('ct_unknown');

      expect(token).toMatchObject({ address: 'ct_unknown', symbol: 'UNK' });
    });

    it('stores a token whose middleware name and symbol Postgres would reject', async () => {
      const { service, dexTokenRepository } = setup();
      dexTokenRepository.findOne.mockResolvedValue(null);
      dexTokenRepository.save.mockImplementation(async (token: any) => token);
      (fetchJson as jest.Mock).mockResolvedValue({
        name: 'Evil\u0000Token',
        symbol: '\u0000',
        decimals: 18,
      });

      const token = await (service as any).getOrCreateToken('ct_evil');

      expect(token).toMatchObject({ name: 'EvilToken', symbol: 'UNK' });
    });

    it.each([
      ['a middleware 5xx', new FetchJsonHttpError('bad gateway', 502)],
      ['a network error', new TypeError('fetch failed')],
    ])(
      'throws on %s instead of storing a placeholder',
      async (_label, error) => {
        const { service, dexTokenRepository } = setup();
        dexTokenRepository.findOne.mockResolvedValue(null);
        (fetchJson as jest.Mock).mockRejectedValue(error);

        await expect(
          (service as any).getOrCreateToken('ct_token'),
        ).rejects.toBe(error);
        expect(dexTokenRepository.save).not.toHaveBeenCalled();
      },
    );
  });

  describe('pair events (real mainnet logs)', () => {
    const WAE = 'ct_J3zBY8xxjsRr3QojETNw48Eb38fjvEuJKkQ6KzECvubvEcvCa';
    const RPT = 'ct_2U1usf3A8ZNUcZLkZe5rEoBTxk7eJvk9fcbRDNqmRiwXCHAYN';
    const WAE_RPT_PAIR =
      'ct_2uny6n3qLA1kgboiK4GBYmmdbQKvCCcgU2VvfrVwLiCc5gPFuP';
    const ABC = 'ct_7UfopTwsRuLGFEcsScbYgQ6YnySXuyMxQWhw6fjycnzS5Nyzq';
    const WAE_ABC_PAIR = 'ct_YtiVs9sGTqm8xoGgPt7iXNoXYTqMELvprUHXFbjpdZA1yQf5Z';
    const AEETH = 'ct_ryTY1mxqjCjq1yBn9i6HDaCSdA6thXUFZTA84EMzbWd1SLKdh';
    const WAE_AEETH_PAIR =
      'ct_2iV2XwSftHrigPZGLrTJkhpxYvRQCHRgQA9V8NiEkGNe5Vb8hB';
    // Token order as each pair stores it on mainnet.
    const factoryPairs: Record<string, { token0: string; token1: string }> = {
      [WAE_RPT_PAIR]: { token0: RPT, token1: WAE },
      [WAE_ABC_PAIR]: { token0: ABC, token1: WAE },
      [WAE_AEETH_PAIR]: { token0: WAE, token1: AEETH },
    };
    const SYNC_HASH =
      '24432301949580458371007546625426791671600583970925974457610567576514658171178';
    const PAIR_BURN_HASH =
      '88978675868420964748173135996126183549496444525344394218626270832788081638717';

    const swap = mainnetTxs.swapAeForRpt;
    const removeLiquidity = mainnetTxs.removeLiquidityAeAbc;
    const withLog = (tx: any, log: any[]) => ({
      ...tx,
      raw: { ...tx.raw, log },
    });
    const entry = (tx: any, address: string, topic0: string) => {
      const found = tx.raw.log.find(
        (e: any) => e.address === address && e.topics[0] === topic0,
      );
      if (!found) throw new Error(`No ${topic0} event from ${address}`);
      return found;
    };

    const setupPairs = () => {
      const ctx = setup();
      ctx.dexTokenRepository.findOne.mockImplementation(({ where }) =>
        Promise.resolve({ address: where.address }),
      );
      // Like factory.get_pair: either token order, null for unknown tokens.
      ctx.pairService.getFactoryPairAddress.mockImplementation((a, b) =>
        Promise.resolve(
          Object.keys(factoryPairs).find((pair) => {
            const { token0, token1 } = factoryPairs[pair];
            return [a, b].sort().join() === [token0, token1].sort().join();
          }) ?? null,
        ),
      );
      ctx.pairService.getPairTokens.mockImplementation((pair) =>
        Promise.resolve(factoryPairs[pair]),
      );
      return ctx;
    };
    const extract = (service: any, tx: any) =>
      service.extractPairInfoFromTransaction(tx);

    it('records the factory pair of a swap, with tokens in the pair order', async () => {
      const { service, pairService } = setupPairs();

      const result = await extract(service, swap);

      expect(pairService.getFactoryPairAddress).toHaveBeenCalledWith(WAE, RPT);
      expect(result.pairAddress).toBe(WAE_RPT_PAIR);
      // The caller's path is WAE→RPT; the pair (and its reserves) are RPT/WAE.
      expect(result.token0.address).toBe(RPT);
      expect(result.token1.address).toBe(WAE);
      expect(result.reserve0).toBe('651429078341558327854687');
      expect(result.reserve1).toBe('5170855094038597954340');
      expect(result.volume0).toBe('1506031712505378772');
      expect(result.pairMintInfo).toBeNull();
    });

    describe('finds the pair in the call arguments of', () => {
      const routerFunctions = (routerAci as any[]).find(
        (entry) => entry.contract?.name === 'AedexV2Router',
      ).contract.functions;
      // Builds arguments by the router's parameter names, so the positions come
      // from its ACI rather than from the code under test.
      const callArgs = (fn: string, values: Record<string, unknown>) =>
        routerFunctions
          .find((f: any) => f.name === fn)
          .arguments.map(
            ({ name }: any) => values[name] ?? { type: 'int', value: 0 },
          );
      const contract = (value: string) => ({ type: 'contract', value });
      // Three tokens, so a first-hop lookup would find the ABC/WAE pair.
      const path = {
        path: {
          type: 'list',
          value: [contract(ABC), contract(WAE), contract(RPT)],
        },
      };
      const tokens = { token_a: contract(WAE), token_b: contract(RPT) };
      const token = { token: contract(RPT) };

      it.each([
        [TX_FUNCTIONS.swap_exact_tokens_for_tokens, path],
        [TX_FUNCTIONS.swap_tokens_for_exact_tokens, path],
        [TX_FUNCTIONS.swap_exact_tokens_for_ae, path],
        [TX_FUNCTIONS.swap_tokens_for_exact_ae, path],
        [TX_FUNCTIONS.swap_exact_ae_for_tokens, path],
        [TX_FUNCTIONS.swap_ae_for_exact_tokens, path],
        [TX_FUNCTIONS.add_liquidity, tokens],
        [TX_FUNCTIONS.remove_liquidity, tokens],
        [TX_FUNCTIONS.add_liquidity_ae, token],
        [TX_FUNCTIONS.remove_liquidity_ae, token],
      ])('%s', async (fn, values) => {
        const { service } = setupPairs();
        const tx = {
          ...swap,
          function: fn,
          raw: { ...swap.raw, arguments: callArgs(fn, values) },
        };

        await expect(extract(service, tx)).resolves.toMatchObject({
          pairAddress: WAE_RPT_PAIR,
        });
      });
    });

    it('records a multi-hop swap under its last hop', async () => {
      // RPT → WAE → aeETH, stored under WAE/aeETH on prod too. The log is
      // newest-first, so that hop's SwapTokens and Sync come first.
      const { service, pairService } = setupPairs();

      const result = await extract(service, mainnetTxs.swapRptForAeethViaWae);

      expect(pairService.getFactoryPairAddress).toHaveBeenCalledWith(
        WAE,
        AEETH,
      );
      expect(result).toMatchObject({
        pairAddress: WAE_AEETH_PAIR,
        token0: { address: WAE },
        token1: { address: AEETH },
        reserve0: '28144949981655658672644',
        reserve1: '42822654626971121',
        volume0: '20495181913121965',
        volume1: '31089973869',
      });
    });

    it('reads the newest events of the pair, which the router caused', async () => {
      // Anyone can call pair.sync(), e.g. the input token while the router
      // moves it, but that happens before the swap, so further down the log.
      const { service } = setupPairs();
      const olderSync = {
        ...entry(swap, WAE_RPT_PAIR, SYNC_HASH),
        topics: [SYNC_HASH, '1', '1'],
      };

      const result = await extract(
        service,
        withLog(swap, [...swap.raw.log, olderSync]),
      );

      expect(result.reserve0).toBe('651429078341558327854687');
      expect(result.reserve1).toBe('5170855094038597954340');
    });

    it('ignores pair-named events emitted by other contracts in the call', async () => {
      const { service } = setupPairs();
      const realSync = entry(swap, WAE_RPT_PAIR, SYNC_HASH);
      const forgedSync = {
        ...realSync,
        address: 'ct_attacker',
        topics: [SYNC_HASH, '1', '999999999999999999999999999'],
      };

      // Newest first: a forged event emitted last would be read first.
      const result = await extract(
        service,
        withLog(swap, [forgedSync, ...swap.raw.log]),
      );

      expect(result.pairAddress).toBe(WAE_RPT_PAIR);
      expect(result.reserve0).toBe('651429078341558327854687');
      expect(result.reserve1).toBe('5170855094038597954340');
    });

    it('ignores events a token emits after the pair burns', async () => {
      // remove_liquidity_ae calls token.transfer after pair.burn, so the
      // token's events land ahead of the pair's in the log.
      const { service, pairService } = setupPairs();
      const forgedSync = {
        ...entry(removeLiquidity, WAE_ABC_PAIR, SYNC_HASH),
        address: ABC,
        topics: [SYNC_HASH, '1', '1'],
      };
      const forgedBurn = {
        ...entry(removeLiquidity, WAE_ABC_PAIR, PAIR_BURN_HASH),
        address: ABC,
      };

      const result = await extract(
        service,
        withLog(removeLiquidity, [
          forgedSync,
          forgedBurn,
          ...removeLiquidity.raw.log,
        ]),
      );

      expect(pairService.getFactoryPairAddress).toHaveBeenCalledWith(
        ABC,
        DEX_CONTRACTS.wae,
      );
      expect(result.pairAddress).toBe(WAE_ABC_PAIR);
      expect(result.reserve0).toBe('3236906156230969387263');
      expect(result.reserve1).toBe('3377524193269355465624');
      expect(result.pairMintInfo).toEqual({
        type: 'PairBurn',
        amount0: '4414325263621543684',
        amount1: '4606092872399610827',
      });
    });

    it('keeps swap volume when a swap callback emits a PairBurn', async () => {
      // The pair calls the callback before its own Sync, so in the
      // newest-first log the callback's events follow the pair's.
      const { service } = setupPairs();
      const callbackBurn = {
        ...entry(removeLiquidity, WAE_ABC_PAIR, PAIR_BURN_HASH),
        address: 'ct_callback',
      };
      const [swapTokens, sync, ...rest] = swap.raw.log;

      const result = await extract(
        service,
        withLog(swap, [swapTokens, sync, callbackBurn, ...rest]),
      );

      expect(result.pairMintInfo).toBeNull();
      expect(result.volume0).toBe('1506031712505378772');
    });

    it('throws when the factory has no pair for the called tokens', async () => {
      const { service, pairService } = setupPairs();
      pairService.getFactoryPairAddress.mockResolvedValue(null);

      await expect(extract(service, swap)).rejects.toThrow(
        'Factory has no pair',
      );
    });

    it('propagates node errors from the factory lookup, so the tx is parked', async () => {
      const { service, pairService } = setupPairs();
      pairService.getFactoryPairAddress.mockRejectedValue(
        new Error('socket hang up'),
      );

      await expect(extract(service, swap)).rejects.toThrow('socket hang up');
    });

    it('skips a reverted call without asking the factory', async () => {
      const { service, pairService } = setupPairs();

      await expect(extract(service, withLog(swap, []))).resolves.toBeNull();
      expect(pairService.getFactoryPairAddress).not.toHaveBeenCalled();
    });

    it('skips a call in which its pair emitted nothing', async () => {
      const { service } = setupPairs();
      jest.spyOn((service as any).logger, 'error').mockImplementation();
      const otherEvents = swap.raw.log.filter(
        (e: any) => e.address !== WAE_RPT_PAIR,
      );

      await expect(
        extract(service, withLog(swap, otherEvents)),
      ).resolves.toBeNull();
    });
  });

  it('stores reserves/ratios/volumes as full-precision strings (no toNumber truncation)', async () => {
    const { service } = setup();
    const upsert = jest.fn().mockResolvedValue(undefined);
    const pairTransactionRepository = {
      upsert,
      findOne: jest.fn().mockResolvedValue({
        tx_hash: 'th_1',
        pair: { address: 'ct_pair' },
      }),
    } as any;
    const manager = {
      getRepository: jest.fn().mockReturnValue(pairTransactionRepository),
    } as any;

    // 24-digit reserve — exceeds Number.MAX_SAFE_INTEGER (~9e15).
    const bigReserve = '820442033002146053770130';

    await (service as any).saveDexPairTransaction(
      { address: 'ct_pair' },
      {
        reserve0: bigReserve,
        reserve1: '1000000000000000000',
        volume0: '500000000000000000',
        volume1: '0',
        swapInfo: null,
        pairMintInfo: null,
      },
      {
        hash: 'th_1',
        block_height: 1,
        micro_time: '1000',
        caller_id: 'ak_1',
        function: 'swap',
      },
      manager,
    );

    const payload = upsert.mock.calls[0][0];
    // Exact value preserved (old code went through toNumber() → lossy float).
    expect(payload.reserve0).toBe(bigReserve);
    expect(typeof payload.reserve0).toBe('string');
    expect(payload.volume0).toBe('500000000000000000');
    // ratio0 = reserve0 / reserve1, full precision.
    expect(payload.ratio0).toBe('820442.03300214605377013');
  });

  it('loads pair relation after upsert when fetching saved tx', async () => {
    const { service } = setup();
    const pairTransactionRepository = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue({
        tx_hash: 'th_1',
        pair: { address: 'ct_pair' },
      }),
    } as any;
    const manager = {
      getRepository: jest.fn().mockReturnValue(pairTransactionRepository),
    } as any;

    await (service as any).saveDexPairTransaction(
      { address: 'ct_pair' },
      {
        reserve0: '1',
        reserve1: '1',
        volume0: 0,
        volume1: 0,
        swapInfo: null,
        pairMintInfo: null,
      },
      {
        hash: 'th_1',
        block_height: 1,
        micro_time: '1000',
        caller_id: 'ak_1',
        function: 'swap',
      },
      manager,
    );

    expect(pairTransactionRepository.findOne).toHaveBeenCalledWith({
      where: { tx_hash: 'th_1' },
      relations: { pair: true },
    });
  });

  describe('removeByTxHashes (reorg cleanup)', () => {
    it('is a no-op for an empty hash list', async () => {
      const { service, dexPairTransactionRepository, dexTokenSummaryService } =
        setup();

      const removed = await service.removeByTxHashes([]);

      expect(removed).toBe(0);
      expect(dexPairTransactionRepository.delete).not.toHaveBeenCalled();
      expect(
        dexTokenSummaryService.createOrUpdateSummary,
      ).not.toHaveBeenCalled();
    });

    it('deletes orphaned pair_transactions and recomputes affected token summaries', async () => {
      const { service, dexPairTransactionRepository, dexTokenSummaryService } =
        setup();

      const qb: any = {
        leftJoin: jest.fn(() => qb),
        select: jest.fn(() => qb),
        addSelect: jest.fn(() => qb),
        where: jest.fn(() => qb),
        getRawMany: jest.fn().mockResolvedValue([
          { token0_address: 'ct_t0', token1_address: 'ct_wae' },
          { token0_address: 'ct_t0', token1_address: 'ct_t1' },
        ]),
      };
      dexPairTransactionRepository.createQueryBuilder.mockReturnValue(qb);
      dexPairTransactionRepository.delete.mockResolvedValue({ affected: 2 });

      const removed = await service.removeByTxHashes(['th_1', 'th_2']);

      expect(removed).toBe(2);
      expect(dexPairTransactionRepository.delete).toHaveBeenCalledTimes(1);
      // Each distinct token gets exactly one recompute (no duplicates for ct_t0).
      const recomputed = (
        dexTokenSummaryService.createOrUpdateSummary as jest.Mock
      ).mock.calls.map((c) => c[0]);
      expect(new Set(recomputed)).toEqual(
        new Set(['ct_t0', 'ct_wae', 'ct_t1']),
      );
      expect(recomputed).toHaveLength(3);
    });

    it('skips recompute when nothing was actually deleted', async () => {
      const { service, dexPairTransactionRepository, dexTokenSummaryService } =
        setup();

      const qb: any = {
        leftJoin: jest.fn(() => qb),
        select: jest.fn(() => qb),
        addSelect: jest.fn(() => qb),
        where: jest.fn(() => qb),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      dexPairTransactionRepository.createQueryBuilder.mockReturnValue(qb);
      dexPairTransactionRepository.delete.mockResolvedValue({ affected: 0 });

      const removed = await service.removeByTxHashes(['th_unknown']);

      expect(removed).toBe(0);
      expect(
        dexTokenSummaryService.createOrUpdateSummary,
      ).not.toHaveBeenCalled();
    });
  });
});
