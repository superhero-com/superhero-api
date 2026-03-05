import { TX_FUNCTIONS } from '@/configs';
import { DexSyncService } from './dex-sync.service';

describe('DexSyncService', () => {
  const setup = () => {
    const dexTokenRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      find: jest.fn(),
    } as any;
    const dexPairRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
      find: jest.fn(),
    } as any;
    const dexPairTransactionRepository = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    } as any;

    const service = new DexSyncService(
      dexTokenRepository,
      dexPairRepository,
      dexPairTransactionRepository,
      { sdk: {} } as any,
      { findByAddress: jest.fn(), pullPairData: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service, dexPairTransactionRepository };
  };

  it('falls back to factory decode when router decode returns empty array', async () => {
    const { service } = setup();
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
      tx: {
        function: TX_FUNCTIONS.add_liquidity,
        arguments: [{ value: 'ct_t0' }, { value: 'ct_t1' }],
        log: [],
      },
    });

    expect(routerDecode).toHaveBeenCalledTimes(1);
    expect(factoryDecode).toHaveBeenCalledTimes(1);
    expect(result?.pairAddress).toBe('ct_pair');
  });

  it('loads pair relation after upsert when fetching saved tx', async () => {
    const { service, dexPairTransactionRepository } = setup();
    dexPairTransactionRepository.findOne.mockResolvedValue({
      tx_hash: 'th_1',
      pair: { address: 'ct_pair' },
    });

    await (service as any).saveDexPairTransaction(
      { address: 'ct_pair' },
      {
        hash: 'th_1',
        blockHeight: 1,
        microTime: 1000,
        tx: { callerId: 'ak_1', function: 'swap' },
      },
      {
        reserve0: 1,
        reserve1: 1,
        volume0: 0,
        volume1: 0,
        swapInfo: null,
        pairMintInfo: null,
      },
    );

    expect(dexPairTransactionRepository.findOne).toHaveBeenCalledWith({
      where: { tx_hash: 'th_1' },
      relations: { pair: true },
    });
  });
});
