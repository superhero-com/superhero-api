import 'dotenv/config';
import { DataSource } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token, UNRANKED_TOKEN_RANK } from './entities/token.entity';
import { TokenEligibilityCounts } from './entities/token-eligibility-counts.entity';
import { TokenPerformance } from './entities/token-performance.entity';
import { TokenTradeEligibilityCounts } from './entities/token-trade-eligibility-counts.entity';
import { TokensService } from './tokens.service';

const d = process.env.DB_HOST ? describe : describe.skip;

// [sale_address, holders_count, rank]: three holders_count tie groups and an
// unranked block, inserted out of sale_address order.
const LISTED: [string, number, number][] = [
  ['ct_f', 5, 3],
  ['ct_b', 1, UNRANKED_TOKEN_RANK],
  ['ct_j', 5, 1],
  ['ct_a', 3, UNRANKED_TOKEN_RANK],
  ['ct_h', 1, 4],
  ['ct_c', 5, UNRANKED_TOKEN_RANK],
  ['ct_g', 3, 2],
  ['ct_e', 1, 5],
  ['ct_d', 3, UNRANKED_TOKEN_RANK],
  ['ct_i', 5, 6],
];

d('TokensService.queryTokensWithRanks (integration)', () => {
  let db: IsolatedDb;
  let ds: DataSource;
  let service: TokensService;

  // TokensController.listAll's base query.
  const listed = () =>
    ds
      .getRepository(Token)
      .createQueryBuilder('token')
      .select('token.*')
      .where('token.unlisted = false');

  const pageThrough = async (orderBy: string, direction: 'ASC' | 'DESC') => {
    const ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const { items } = await service.queryTokensWithRanks(
        listed(),
        4,
        page,
        orderBy,
        direction,
      );
      ids.push(...items.map((token) => token.sale_address));
    }
    return ids;
  };

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      migrations: [],
      entities: [
        Token,
        TokenPerformance,
        TokenEligibilityCounts,
        TokenTradeEligibilityCounts,
      ],
    });
    ds = db.dataSource;
    await ds.synchronize();

    await ds.getRepository(Token).insert([
      ...LISTED.map(([sale_address, holders_count, rank]) => ({
        sale_address,
        holders_count,
        rank,
        name: sale_address,
        symbol: `sym_${sale_address}`,
      })),
      // Would lead every list below if the filter were dropped.
      {
        sale_address: 'ct_0',
        unlisted: true,
        holders_count: 9,
        rank: 0,
        trending_score: 1,
        name: 'ct_0',
        symbol: 'sym_ct_0',
      },
    ]);
    await ds.getRepository(Token).update('ct_c', { trending_score: 0.5 });
    await ds.getRepository(Token).update('ct_j', { trending_score: 0.7 });
    await ds.getRepository(TokenPerformance).insert({ sale_address: 'ct_j' });
    await ds.getRepository(TokenEligibilityCounts).insert(
      ['ct_0', 'ct_c', 'ct_f', 'ct_j'].map((id) => ({
        symbol: `SYM_${id.toUpperCase()}`,
        post_count: 2,
      })),
    );
    await ds.getRepository(TokenTradeEligibilityCounts).insert([
      { sale_address: 'ct_0', trade_count: 3 },
      { sale_address: 'ct_c', trade_count: 3 },
      { sale_address: 'ct_f', trade_count: 2 },
      { sale_address: 'ct_j', trade_count: 3 },
    ]);

    service = new TokensService(
      ds.getRepository(Token),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  it('pages through holders_count ties once each, by sale address', async () => {
    expect(await pageThrough('holders_count', 'DESC')).toEqual([
      ...['ct_c', 'ct_f', 'ct_i', 'ct_j'],
      ...['ct_a', 'ct_d', 'ct_g'],
      ...['ct_b', 'ct_e', 'ct_h'],
    ]);
  });

  it('lists by market cap with unranked tokens last, by sale address', async () => {
    expect(await pageThrough('market_cap', 'DESC')).toEqual([
      ...['ct_j', 'ct_g', 'ct_f', 'ct_h', 'ct_e', 'ct_i'],
      ...['ct_a', 'ct_b', 'ct_c', 'ct_d'],
    ]);
  });

  it('returns full token rows with performance where a row exists', async () => {
    const { items } = await service.queryTokensWithRanks(listed(), 2, 1);

    expect(items.map((token) => token.sale_address)).toEqual(['ct_j', 'ct_g']);
    expect(items[0]).toMatchObject({
      name: 'ct_j',
      symbol: 'sym_ct_j',
      holders_count: 5,
      unlisted: false,
      performance: { sale_address: 'ct_j' },
    });
    expect(items[1].performance).toBeNull();
  });

  it('pages through trending ties once each, by sale address', async () => {
    // The controller's fallback when no token passes eligibility: every
    // zero-score token shares created_at, so only sale_address orders them.
    expect(await pageThrough('trending_score', 'DESC')).toEqual([
      ...['ct_j', 'ct_c'],
      ...['ct_a', 'ct_b', 'ct_d', 'ct_e', 'ct_f', 'ct_g', 'ct_h', 'ct_i'],
    ]);
  });

  it('never lists unlisted tokens, even if the caller does not filter them', async () => {
    const { items } = await service.queryTokensWithRanks(
      ds.getRepository(Token).createQueryBuilder('token').select('token.*'),
      20,
      1,
    );

    expect(items.map((token) => token.sale_address)).not.toContain('ct_0');
    expect(items).toHaveLength(LISTED.length);
  });

  it('applies the trending eligibility filter', async () => {
    const result = await service.queryTokensWithRanks(
      service.applyListEligibilityFilters(listed()),
      20,
      1,
      'trending_score',
      'DESC',
    );

    expect(result.items.map((token) => token.sale_address)).toEqual([
      'ct_j',
      'ct_c',
    ]);
    expect(result.meta.totalItems).toBe(2);
  });

  it('returns the total for a page past the end', async () => {
    const result = await service.queryTokensWithRanks(listed(), 4, 4);

    expect(result.items).toEqual([]);
    expect(result.meta).toEqual({
      currentPage: 4,
      itemCount: 0,
      itemsPerPage: 4,
      totalItems: 10,
      totalPages: 3,
    });
  });
});
