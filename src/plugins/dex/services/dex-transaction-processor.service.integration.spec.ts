import 'dotenv/config';
import { DexTokenSummary } from '@/dex/entities/dex-token-summary.entity';
import { DexToken } from '@/dex/entities/dex-token.entity';
import { PairSummary } from '@/dex/entities/pair-summary.entity';
import { PairTransaction } from '@/dex/entities/pair-transaction.entity';
import { Pair } from '@/dex/entities/pair.entity';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { DexTransactionProcessorService } from './dex-transaction-processor.service';
import mainnetTxs from './__fixtures__/mainnet-router-txs.json';

const d = process.env.DB_HOST ? describe : describe.skip;

d('DexTransactionProcessorService (integration)', () => {
  const WAE = 'ct_J3zBY8xxjsRr3QojETNw48Eb38fjvEuJKkQ6KzECvubvEcvCa';
  const RPT = 'ct_2U1usf3A8ZNUcZLkZe5rEoBTxk7eJvk9fcbRDNqmRiwXCHAYN';
  const WAE_RPT_PAIR = 'ct_2uny6n3qLA1kgboiK4GBYmmdbQKvCCcgU2VvfrVwLiCc5gPFuP';
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Pair, DexToken, PairTransaction, PairSummary, DexTokenSummary],
      migrations: [BaseSchema1718900000000],
    });
    await db.dataSource.runMigrations();
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  it('stores a new pair in its own token order, not the swap path order', async () => {
    const ds = db.dataSource;
    await ds.getRepository(DexToken).save([
      { address: WAE, name: 'Wrapped AE', symbol: 'WAE', decimals: 18 },
      { address: RPT, name: 'RPT', symbol: 'RPT', decimals: 18 },
    ]);
    // Only the chain reads are faked.
    const pairService = {
      getFactoryPairAddress: jest.fn().mockResolvedValue(WAE_RPT_PAIR),
      getPairTokens: jest.fn().mockResolvedValue({ token0: RPT, token1: WAE }),
      pullPairData: jest.fn().mockResolvedValue(undefined),
    };
    const aeSdkService = {
      sdk: {
        getContext: () => ({
          onNode: { getContract: async () => ({ active: true }) },
        }),
      },
    };
    const service = new DexTransactionProcessorService(
      ds.getRepository(DexToken),
      ds.getRepository(Pair),
      ds.getRepository(PairTransaction),
      aeSdkService as any,
      pairService as any,
      {} as any,
    );

    // The swap path is WAE→RPT.
    await service.processTransaction(
      mainnetTxs.swapAeForRpt as any,
      'live' as any,
    );

    expect(
      await ds.query(
        `SELECT token0_address, token1_address FROM pairs WHERE address = $1`,
        [WAE_RPT_PAIR],
      ),
    ).toEqual([{ token0_address: RPT, token1_address: WAE }]);
    expect(
      await ds.query(
        `SELECT pair_address, reserve0, reserve1, volume0, volume1
           FROM pair_transactions WHERE tx_hash = $1`,
        [mainnetTxs.swapAeForRpt.hash],
      ),
    ).toEqual([
      {
        pair_address: WAE_RPT_PAIR,
        reserve0: '651429078341558327854687',
        reserve1: '5170855094038597954340',
        volume0: '1506031712505378772',
        volume1: '10000000000000000',
      },
    ]);
  });
});
