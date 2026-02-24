import { TX_FUNCTIONS } from '@/configs';
import { DexTransactionProcessorService } from './dex-transaction-processor.service';

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
    } as any;
    const pairService = { pullPairData: jest.fn() } as any;

    const service = new DexTransactionProcessorService(
      dexTokenRepository,
      dexPairRepository,
      dexPairTransactionRepository,
      { sdk: {} } as any,
      pairService,
    );

    return { service };
  };

  it('falls back to factory decode when router decode returns empty array', async () => {
    const { service } = setup();
    jest
      .spyOn(service as any, 'ensureContractsInitialized')
      .mockResolvedValue(undefined);
    const routerDecode = jest.fn().mockReturnValue([]);
    const factoryDecode = jest.fn().mockReturnValue([
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
});
