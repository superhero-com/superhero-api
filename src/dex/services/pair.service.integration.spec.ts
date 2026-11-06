import 'dotenv/config';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { DexTokenSummary } from '../entities/dex-token-summary.entity';
import { DexToken } from '../entities/dex-token.entity';
import { PairSummary } from '../entities/pair-summary.entity';
import { PairTransaction } from '../entities/pair-transaction.entity';
import { Pair } from '../entities/pair.entity';
import { PairService } from './pair.service';

const d = process.env.DB_HOST ? describe : describe.skip;

d('PairService.syncPairFromChain (integration)', () => {
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

  it('persists the pair token order and fresh reserves for a reversed row', async () => {
    const pairs = db.dataSource.getRepository(Pair);
    await db.dataSource.getRepository(DexToken).save([
      { address: 'ct_wae', name: 'Wrapped AE', symbol: 'WAE', decimals: 18 },
      { address: 'ct_rpt', name: 'RPT', symbol: 'RPT', decimals: 18 },
    ]);
    // Stored in the caller's order (WAE first) with reserves from creation.
    await pairs.save({
      address: 'ct_pair',
      token0: { address: 'ct_wae' },
      token1: { address: 'ct_rpt' },
      reserve0: 682278,
      reserve1: 1683,
    });

    const service = new PairService(pairs, {} as any);
    jest.spyOn(service, 'getPairContract').mockResolvedValue({
      token0: async () => ({ decodedResult: 'ct_rpt' }),
      token1: async () => ({ decodedResult: 'ct_wae' }),
      total_supply: async () => ({ decodedResult: 30n }),
      get_reserves: async () => ({
        decodedResult: {
          reserve0: 651429078341558327854687n,
          reserve1: 5170855094038597954340n,
        },
      }),
    } as any);

    // Loaded the way the price sync loads it.
    const [row] = await pairs.find({
      relations: { token0: true, token1: true },
    });
    await service.syncPairFromChain(row);

    const stored = await db.dataSource.query(
      `SELECT token0_address, token1_address, reserve0, reserve1
         FROM pairs WHERE address = 'ct_pair'`,
    );
    expect(stored).toEqual([
      {
        token0_address: 'ct_rpt',
        token1_address: 'ct_wae',
        reserve0: '651429078341558327854687',
        reserve1: '5170855094038597954340',
      },
    ]);
  });
});
