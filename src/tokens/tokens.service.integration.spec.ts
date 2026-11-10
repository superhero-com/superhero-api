import 'dotenv/config';
import BigNumber from 'bignumber.js';
import { DataSource } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token, UNRANKED_TOKEN_RANK } from './entities/token.entity';
import { TokenHolder } from './entities/token-holders.entity';
import { TokenEligibilityCounts } from './entities/token-eligibility-counts.entity';
import { TokenPerformance } from './entities/token-performance.entity';
import { TokenRank } from './entities/token-rank.entity';
import { TokenTradeEligibilityCounts } from './entities/token-trade-eligibility-counts.entity';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { attachTokenRanks } from './utils/token-rank.util';

const d = process.env.DB_HOST ? describe : describe.skip;

const FACTORY = 'ct_factory';

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
        TokenRank,
        TokenEligibilityCounts,
        TokenTradeEligibilityCounts,
      ],
    });
    ds = db.dataSource;
    await ds.synchronize();
    // Migrated databases still have the retired column until it is dropped.
    await ds.query(
      `ALTER TABLE token ADD COLUMN rank integer NOT NULL DEFAULT ${UNRANKED_TOKEN_RANK}`,
    );

    await ds.getRepository(Token).insert([
      ...LISTED.map(([sale_address, holders_count]) => ({
        sale_address,
        holders_count,
        name: sale_address,
        symbol: `sym_${sale_address}`,
        factory_address: FACTORY,
      })),
      // Would lead every list below if the filter were dropped.
      {
        sale_address: 'ct_0',
        unlisted: true,
        holders_count: 9,
        trending_score: 1,
        name: 'ct_0',
        symbol: 'sym_ct_0',
        factory_address: FACTORY,
      },
    ]);
    const ranked: [string, number][] = [
      ...LISTED.filter(([, , rank]) => rank !== UNRANKED_TOKEN_RANK).map(
        ([sale_address, , rank]): [string, number] => [sale_address, rank],
      ),
      ['ct_0', 0],
    ];
    for (const [sale_address, rank] of ranked) {
      await ds.getRepository(TokenRank).insert({ sale_address, rank });
      // Stale and in the reverse order, so a reader of it would show.
      await ds.query('UPDATE token SET rank = $2 WHERE sale_address = $1', [
        sale_address,
        100 - rank,
      ]);
    }
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

    service = newService();
  }, 60_000);

  const newService = () =>
    new TokensService(
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

  it('returns the rank from token_rank, with the sentinel for unranked tokens', async () => {
    const { items } = await service.queryTokensWithRanks(
      listed(),
      20,
      1,
      'holders_count',
      'DESC',
    );

    const rankOf = Object.fromEntries(
      items.map((token) => [token.sale_address, token.rank]),
    );
    expect(rankOf).toEqual(
      Object.fromEntries(
        LISTED.map(([sale_address, , rank]) => [sale_address, rank]),
      ),
    );
    expect(items[0]).not.toHaveProperty('current_rank');
  });

  it('lists by rank in either direction from token_rank', async () => {
    expect(await pageThrough('rank', 'ASC')).toEqual(
      await pageThrough('market_cap', 'DESC'),
    );
    expect(await pageThrough('rank', 'DESC')).toEqual([
      ...['ct_a', 'ct_b', 'ct_c', 'ct_d'],
      ...['ct_i', 'ct_e', 'ct_h', 'ct_f', 'ct_g', 'ct_j'],
    ]);
  });

  describe('reused rank order', () => {
    const page = (
      target: TokensService,
      pageNumber: number,
      direction: 'ASC' | 'DESC',
      reuseRankOrder: boolean,
    ) =>
      target.queryTokensWithRanks(
        listed(),
        4,
        pageNumber,
        'market_cap',
        direction,
        { reuseRankOrder },
      );

    it('serves the same pages as the direct query', async () => {
      const reusing = newService();
      for (const direction of ['ASC', 'DESC'] as const) {
        for (let pageNumber = 1; pageNumber <= 4; pageNumber++) {
          expect(await page(reusing, pageNumber, direction, true)).toEqual(
            await page(service, pageNumber, direction, false),
          );
        }
      }
    });

    it('keeps rows live and never lists a token unlisted since', async () => {
      const reusing = newService();
      await page(reusing, 1, 'DESC', true);
      await ds.query(
        `UPDATE token SET holders_count = 42 WHERE sale_address = 'ct_j'`,
      );
      await ds.query(
        `UPDATE token SET unlisted = true WHERE sale_address = 'ct_g'`,
      );
      try {
        const { items } = await page(reusing, 1, 'DESC', true);

        expect(items.map((token) => token.sale_address)).toEqual([
          'ct_j',
          'ct_f',
          'ct_h',
        ]);
        expect(items[0]).toMatchObject({ holders_count: 42, rank: 1 });
      } finally {
        await ds.query(
          `UPDATE token SET holders_count = 5 WHERE sale_address = 'ct_j'`,
        );
        await ds.query(
          `UPDATE token SET unlisted = false WHERE sale_address = 'ct_g'`,
        );
      }
    });
  });

  it('findByAddress reports the visible rank', async () => {
    expect((await service.findByAddress('ct_g'))?.['rank']).toBe(2);
    // Not placed yet, and unlisted.
    expect((await service.findByAddress('ct_a'))?.['rank']).toBeUndefined();
    expect((await service.findByAddress('ct_0'))?.['rank']).toBeUndefined();
  });

  it('attachTokenRanks sets the rank the old column held', async () => {
    const repository = ds.getRepository(Token);
    const [placed, unplaced, unlisted] = await Promise.all(
      ['ct_g', 'ct_a', 'ct_0'].map((sale_address) =>
        repository.findOneByOrFail({ sale_address }),
      ),
    );
    // A /transactions page repeats a token and can lack one.
    const tokens = [placed, unplaced, unlisted, { ...placed }, null];

    await attachTokenRanks(ds.manager, tokens);

    // An unlisted token keeps its last rank, as the column did.
    expect(tokens.map((token) => (token as any)?.rank)).toEqual([
      2,
      UNRANKED_TOKEN_RANK,
      0,
      2,
      undefined,
    ]);
  });

  describe('rankings', () => {
    const controller = () =>
      new TokensController(
        ds.getRepository(Token),
        {} as any,
        {} as any,
        service,
        {
          getCurrentFactory: async () => ({ address: FACTORY }),
          mapCollectionInfo: () => null,
        } as any,
        {} as any,
      );
    const ranksAround = async (address: string, limit: number) =>
      (await controller().listTokenRankings(address, 1, limit)).items.map(
        (token: any) => [token.sale_address, token.rank],
      );

    it('centres the window on the token rank from token_rank', async () => {
      expect(await ranksAround('ct_f', 3)).toEqual([
        ['ct_g', 2],
        ['ct_f', 3],
        ['ct_h', 4],
      ]);
    });

    it('fills from above at the bottom of the board, never with unranked tokens', async () => {
      expect(await ranksAround('ct_i', 3)).toEqual([
        ['ct_h', 4],
        ['ct_e', 5],
        ['ct_i', 6],
      ]);
    });

    it('gives a token not placed yet no neighbours', async () => {
      expect(await ranksAround('ct_a', 3)).toEqual([]);
    });
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

d('TokensService.loadAndSaveTokenHoldersFromMdw (integration)', () => {
  let db: IsolatedDb;
  let ds: DataSource;
  let service: TokensService;

  const holder = (address: string) => ({
    id: `${address}_ct_aex9`,
    aex9_address: 'ct_aex9',
    address,
    balance: new BigNumber(1),
  });
  const sync = async (addresses: string[]) => {
    jest.spyOn(service, '_loadHoldersData').mockResolvedValue({
      holders: addresses.map(holder),
      truncated: false,
    });
    await service.loadAndSaveTokenHoldersFromMdw('ct_sale' as any);
  };
  const tokenRow = async () =>
    (
      await ds.query(
        `SELECT holders_count, xmin::text AS xmin, ctid::text AS ctid
         FROM token WHERE sale_address = 'ct_sale'`,
      )
    )[0];

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      migrations: [],
      entities: [Token, TokenHolder],
    });
    ds = db.dataSource;
    await ds.synchronize();
    await ds.getRepository(Token).insert({
      sale_address: 'ct_sale',
      address: 'ct_aex9',
      name: 'BLA',
      symbol: 'BLA',
    });
    service = new TokensService(
      ds.getRepository(Token),
      ds.getRepository(TokenHolder),
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
    jest
      .spyOn(service, 'getToken')
      .mockImplementation((address) =>
        ds.getRepository(Token).findOneBy({ sale_address: address }),
      );
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  it('rewrites the token row only when the holder count changes', async () => {
    await sync(['ak_1', 'ak_2']);
    const written = await tokenRow();
    expect(written.holders_count).toBe(2);

    await sync(['ak_1', 'ak_2']);
    expect(await tokenRow()).toEqual(written);

    await sync(['ak_1', 'ak_2', 'ak_3']);
    const changed = await tokenRow();
    expect(changed.holders_count).toBe(3);
    expect(changed.xmin).not.toBe(written.xmin);
  });
});
