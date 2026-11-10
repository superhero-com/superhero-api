import 'dotenv/config';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import BigNumber from 'bignumber.js';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { DexTokenSummary } from '../entities/dex-token-summary.entity';
import { DexToken } from '../entities/dex-token.entity';
import { PairSummary } from '../entities/pair-summary.entity';
import { PairTransaction } from '../entities/pair-transaction.entity';
import { Pair } from '../entities/pair.entity';
import { PairHistoryService } from './pair-history.service';

const d = process.env.DB_HOST ? describe : describe.skip;

const WAE = DEX_CONTRACTS.wae;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const E18 = '000000000000000000';

d('PairHistoryService.calculatePairSummary (integration)', () => {
  let db: IsolatedDb;
  let service: PairHistoryService;
  let pairs: Pair[];

  const pairByAddress = (address: string) =>
    pairs.find((p) => p.address === address);

  const insertTx = (row: {
    hash: string;
    pair: string;
    type: string;
    ageMs: number;
    volume0?: string;
    volume1?: string;
    ratio0?: string;
    ratio1?: string;
  }) =>
    db.dataSource.query(
      `INSERT INTO pair_transactions
         (tx_hash, pair_address, tx_type, volume0, volume1, ratio0, ratio1, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.hash,
        row.pair,
        row.type,
        row.volume0 ?? '0',
        row.volume1 ?? '0',
        row.ratio0 ?? '0',
        row.ratio1 ?? '0',
        // Same Date serialization as the service's period bounds.
        new Date(Date.now() - row.ageMs),
      ],
    );

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Pair, DexToken, PairTransaction, PairSummary, DexTokenSummary],
      migrations: [BaseSchema1718900000000],
    });
    await db.dataSource.runMigrations();

    await db.dataSource.getRepository(DexToken).save([
      { address: WAE, name: 'Wrapped AE', symbol: 'WAE', decimals: 18 },
      { address: 'ct_six', name: 'Six', symbol: 'SIX', decimals: 6 },
      { address: 'ct_a', name: 'A', symbol: 'A', decimals: 18 },
      { address: 'ct_b', name: 'B', symbol: 'B', decimals: 18 },
    ]);
    await db.dataSource.getRepository(Pair).save([
      // WAE is token1 here and token0 below, so both CASE branches are hit.
      {
        address: 'ct_six_wae',
        token0: { address: 'ct_six' },
        token1: { address: WAE },
      },
      {
        address: 'ct_wae_a',
        token0: { address: WAE },
        token1: { address: 'ct_a' },
      },
      {
        address: 'ct_a_b',
        token0: { address: 'ct_a' },
        token1: { address: 'ct_b' },
      },
    ]);

    // ct_six_wae: SIX has 6 decimals, so a raw ratio0 of p·1e-12 is a human
    // price p (AE per SIX) and a raw ratio1 of p·1e12 is a human price p (SIX
    // per AE). The volumes are AE amounts on the WAE side.
    const sixWae = [
      {
        hash: 'th_60d',
        type: 'swap_exact_ae_for_tokens',
        ageMs: 60 * DAY,
        volume1: `8${E18}`,
        ratio0: '0.000000000001',
        ratio1: '8000000000000',
      },
      {
        hash: 'th_20d',
        type: 'swap_tokens_for_exact_ae',
        ageMs: 20 * DAY,
        volume1: `4${E18}`,
        ratio0: '0.000000000002',
        ratio1: '4000000000000',
      },
      {
        hash: 'th_3d',
        type: 'swap_exact_tokens_for_ae',
        ageMs: 3 * DAY,
        volume1: `2${E18}`,
        ratio0: '0.000000000004',
        ratio1: '2000000000000',
      },
      // Not a swap: its volume must not count, but its ratio is still the
      // earliest price inside the 24h window.
      {
        hash: 'th_2h_liq',
        type: 'add_liquidity_ae',
        ageMs: 2 * HOUR,
        volume1: `16${E18}`,
        ratio0: '0.0000000000025',
        ratio1: '2000000000000',
      },
      {
        hash: 'th_1h',
        type: 'swap_ae_for_exact_tokens',
        ageMs: 1 * HOUR,
        volume1: `1${E18}`,
        ratio0: '0.000000000005',
        ratio1: '1000000000000',
      },
    ];
    for (const row of sixWae) {
      await insertTx({ pair: 'ct_six_wae', ...row });
    }
    await insertTx({
      hash: 'th_wae_a',
      pair: 'ct_wae_a',
      type: 'swap_exact_tokens_for_tokens',
      ageMs: 5 * DAY,
      volume0: `3${E18}`,
      volume1: `7${E18}`,
      ratio0: '1',
      ratio1: '1',
    });
    await insertTx({
      hash: 'th_a_b',
      pair: 'ct_a_b',
      type: 'swap_tokens_for_exact_tokens',
      ageMs: 1 * HOUR,
      volume0: `5${E18}`,
      volume1: `6${E18}`,
      ratio0: '1',
      ratio1: '1',
    });

    // Loaded the way the price sync loads them.
    pairs = await db.dataSource
      .getRepository(Pair)
      .find({ relations: { token0: true, token1: true } });

    service = new PairHistoryService({} as any, db.dataSource, {
      getPriceData: async (ae: BigNumber) => ({ ae: ae.toString() }),
    } as any);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  const volumes = (summary: any) => ({
    total: summary.total_volume.ae,
    '24h': summary.change['24h'].volume.ae,
    '7d': summary.change['7d'].volume.ae,
    '30d': summary.change['30d'].volume.ae,
  });
  const priceChanges = (summary: any) => ({
    '24h': summary.change['24h'].price_change,
    '7d': summary.change['7d'].price_change,
    '30d': summary.change['30d'].price_change,
  });

  it('sums the WAE leg of swaps per window and prices the other token in AE', async () => {
    const summary: any = await service.calculatePairSummary(
      pairByAddress('ct_six_wae'),
    );

    expect(summary.token_position).toBe('1');
    expect(volumes(summary)).toEqual({
      total: '15',
      '24h': '1',
      '7d': '3',
      '30d': '7',
    });
    // Current price 5; each window starts at its earliest row of any type.
    expect(priceChanges(summary)).toEqual({
      '24h': { percentage: '100', value: '2.5' },
      '7d': { percentage: '25', value: '1' },
      '30d': { percentage: '150', value: '3' },
    });
  });

  it('prices WAE in the selected token when that token is passed', async () => {
    const summary: any = await service.calculatePairSummary(
      pairByAddress('ct_six_wae'),
      'ct_six',
    );

    expect(summary.token_position).toBe('0');
    // Volume is the WAE leg whichever token is selected.
    expect(volumes(summary)).toEqual({
      total: '15',
      '24h': '1',
      '7d': '3',
      '30d': '7',
    });
    expect(priceChanges(summary)).toEqual({
      '24h': { percentage: '-50', value: '-1' },
      '7d': { percentage: '-50', value: '-1' },
      '30d': { percentage: '-75', value: '-3' },
    });
  });

  it('takes volume0 when WAE is token0 and ignores other pairs', async () => {
    const summary: any = await service.calculatePairSummary(
      pairByAddress('ct_wae_a'),
    );

    expect(summary.token_position).toBe('0');
    expect(volumes(summary)).toEqual({
      total: '3',
      '24h': '0',
      '7d': '3',
      '30d': '3',
    });
  });

  it('reports zero volume for a pair without a WAE side', async () => {
    const summary: any = await service.calculatePairSummary(
      pairByAddress('ct_a_b'),
    );

    expect(volumes(summary)).toEqual({
      total: '0',
      '24h': '0',
      '7d': '0',
      '30d': '0',
    });
  });
});
