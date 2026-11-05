import { TX_FUNCTIONS } from '@/configs';
import { DEX_CONTRACTS } from '@/dex/config/dex-contracts.config';
import { fetchJson, FetchJsonHttpError } from '@/utils/common';
import { DexTransactionProcessorService } from './dex-transaction-processor.service';

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
    const pairService = { pullPairData: jest.fn() } as any;
    const dexTokenSummaryService = {
      createOrUpdateSummary: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new DexTransactionProcessorService(
      dexTokenRepository,
      dexPairRepository,
      dexPairTransactionRepository,
      { sdk: {} } as any,
      pairService,
      dexTokenSummaryService,
    );

    return {
      service,
      dexTokenRepository,
      dexPairTransactionRepository,
      dexTokenSummaryService,
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

  it('falls back to factory decode when router decode returns empty array', async () => {
    const { service } = setup();
    jest
      .spyOn(service as any, 'ensureContractsInitialized')
      .mockResolvedValue(undefined);
    const routerDecode = jest.fn().mockReturnValue([]);
    const factoryDecode = jest
      .fn()
      .mockReturnValue([
        { contract: { name: 'IAedexV2Pair', address: 'ct_pair' } },
      ]);
    (service as any).routerContract = { $decodeEvents: routerDecode };
    (service as any).factoryContract = { $decodeEvents: factoryDecode };
    jest
      .spyOn(service as any, 'getOrCreateToken')
      .mockResolvedValueOnce({ address: 'ct_t0' })
      .mockResolvedValueOnce({ address: 'ct_t1' });

    const result = await (service as any).extractPairInfoFromTransaction({
      hash: 'th_1',
      function: TX_FUNCTIONS.add_liquidity,
      raw: {
        log: [],
        arguments: [{ value: 'ct_t0' }, { value: 'ct_t1' }],
      },
    });

    expect(routerDecode).toHaveBeenCalledTimes(1);
    expect(factoryDecode).toHaveBeenCalledTimes(1);
    expect(result?.pairAddress).toBe('ct_pair');
  });

  it('normalizes string event topics to BigInt before decoding', async () => {
    // The middleware stores topics as decimal strings; aepp-sdk matches them
    // against BigInt event hashes with strict equality, so a string topic never
    // matches and every event is silently dropped. The processor must convert
    // topics to BigInt before calling $decodeEvents.
    const { service } = setup();
    jest
      .spyOn(service as any, 'ensureContractsInitialized')
      .mockResolvedValue(undefined);
    const routerDecode = jest
      .fn()
      .mockReturnValue([
        { contract: { name: 'IAedexV2Pair', address: 'ct_pair' } },
      ]);
    (service as any).routerContract = { $decodeEvents: routerDecode };
    (service as any).factoryContract = { $decodeEvents: jest.fn() };
    jest
      .spyOn(service as any, 'getOrCreateToken')
      .mockResolvedValueOnce({ address: 'ct_t0' })
      .mockResolvedValueOnce({ address: 'ct_t1' });

    const swapTokensHash =
      '72742236172837736358043391645586411318758140104138559400527506523271326125229';

    await (service as any).extractPairInfoFromTransaction({
      hash: 'th_1',
      function: TX_FUNCTIONS.add_liquidity,
      raw: {
        log: [
          { address: 'ct_pair', data: 'cb_x', topics: [swapTokensHash, '1'] },
        ],
        arguments: [{ value: 'ct_t0' }, { value: 'ct_t1' }],
      },
    });

    const passedLog = routerDecode.mock.calls[0][0];
    expect(passedLog[0].topics.every((t: any) => typeof t === 'bigint')).toBe(
      true,
    );
    expect(passedLog[0].topics[0]).toBe(BigInt(swapTokensHash));
  });

  it('does not abort decoding when one log entry has an unconvertible topic', async () => {
    // A non-pair log line in the same tx may carry a null/empty/non-numeric
    // topic. BigInt() throws on those, so converting them unguarded would abort
    // extraction for the whole transaction — even though the valid pair event
    // would decode after conversion.
    const { service } = setup();
    jest
      .spyOn(service as any, 'ensureContractsInitialized')
      .mockResolvedValue(undefined);
    const routerDecode = jest
      .fn()
      .mockReturnValue([
        { contract: { name: 'IAedexV2Pair', address: 'ct_pair' } },
      ]);
    (service as any).routerContract = { $decodeEvents: routerDecode };
    (service as any).factoryContract = { $decodeEvents: jest.fn() };
    jest
      .spyOn(service as any, 'getOrCreateToken')
      .mockResolvedValueOnce({ address: 'ct_t0' })
      .mockResolvedValueOnce({ address: 'ct_t1' });

    const validHash =
      '72742236172837736358043391645586411318758140104138559400527506523271326125229';

    const result = await (service as any).extractPairInfoFromTransaction({
      hash: 'th_1',
      function: TX_FUNCTIONS.add_liquidity,
      raw: {
        log: [
          { address: 'ct_other', data: 'cb_x', topics: [null] }, // unconvertible
          { address: 'ct_pair', data: 'cb_y', topics: [validHash, '1'] }, // valid
        ],
        arguments: [{ value: 'ct_t0' }, { value: 'ct_t1' }],
      },
    });

    // The valid pair event was still decoded — the bad topic did not abort it.
    expect(result?.pairAddress).toBe('ct_pair');
    const passedLog = routerDecode.mock.calls[0][0];
    // Valid entry fully converted to BigInt...
    expect(passedLog[1].topics.every((t: any) => typeof t === 'bigint')).toBe(
      true,
    );
    // ...and the unconvertible topic was left untouched (omitUnknown drops it).
    expect(passedLog[0].topics[0]).toBeNull();
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
