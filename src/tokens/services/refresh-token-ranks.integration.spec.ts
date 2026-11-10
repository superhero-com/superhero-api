import 'dotenv/config';
import { DataSource, QueryRunner } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { TokenRankTable1718900000044 } from '@/migrations/1718900000044-TokenRankTable';
import { Token, UNRANKED_TOKEN_RANK } from '../entities/token.entity';
import { TokenRank } from '../entities/token-rank.entity';
import { RefreshTokenRanksService } from './refresh-token-ranks.service';

const d = process.env.DB_HOST ? describe : describe.skip;

// The refresh this replaces, verbatim: the oracle for every case below.
const OLD_REFRESH_SQL = `
  UPDATE "token"
  SET "rank" = ranked.rank
  FROM (
    SELECT
      sale_address,
      CAST(RANK() OVER (
        ORDER BY
          CASE WHEN market_cap = 0 THEN 1 ELSE 0 END,
          market_cap DESC,
          created_at ASC
      ) AS INTEGER) AS rank
    FROM "token"
    WHERE unlisted = false
  ) ranked
  WHERE "token".sale_address = ranked.sale_address
    AND "token".rank IS DISTINCT FROM ranked.rank
`;

const BASE_CAP = '40805703706800000000';

// [sale_address, market_cap, age in minutes]. A tie block at the base cap
// that new tokens join at the end, zero-cap tokens that sort last, and an
// exact tie (same cap and created_at) that RANK() gives one rank.
const TOKENS: [string, string, number][] = [
  ['ct_top', '90000000000000000000', 500],
  ['ct_second', '60000000000000000000', 400],
  ['ct_base_1', BASE_CAP, 300],
  ['ct_base_2', BASE_CAP, 200],
  ['ct_base_3', BASE_CAP, 100],
  ['ct_low', '1000', 600],
  ['ct_tie_a', '5000', 700],
  ['ct_tie_b', '5000', 700],
  ['ct_zero_1', '0', 900],
  ['ct_zero_2', '0', 800],
];

d('token_rank: migration 1718900000044 and refresh', () => {
  let db: IsolatedDb;
  let ds: DataSource;
  let queryRunner: QueryRunner;
  let service: RefreshTokenRanksService;

  // A fixed clock, so equal ages are equal created_at values.
  const insertToken = (saleAddress: string, marketCap: string, age: number) =>
    ds.query(
      `INSERT INTO token (sale_address, name, symbol, market_cap, created_at)
       VALUES ($1, $1, $1, $2, TIMESTAMP '2026-11-01' - make_interval(mins => $3))`,
      [saleAddress, marketCap, age],
    );

  // What the old column held: a token at the sentinel had no rank.
  const oldRanks = () =>
    ds.query(
      `SELECT sale_address, rank FROM token WHERE rank < $1 ORDER BY sale_address`,
      [UNRANKED_TOKEN_RANK],
    );
  const newRanks = () =>
    ds.query(`SELECT sale_address, rank FROM token_rank ORDER BY sale_address`);

  const versions = (relation: string) =>
    ds.query(
      `SELECT sale_address, xmin::text AS xmin, xmax::text AS xmax FROM ${relation} ORDER BY sale_address`,
    );

  const refreshBoth = async () => {
    await ds.query(OLD_REFRESH_SQL);
    await service.refreshRanks();
  };

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      migrations: [],
      entities: [Token, TokenRank],
    });
    ds = db.dataSource;
    await ds.synchronize();
    // The production schema before this migration: the rank on token.
    await ds.query(`DROP TABLE token_rank`);
    await ds.query(
      `ALTER TABLE token ADD COLUMN rank integer NOT NULL DEFAULT ${UNRANKED_TOKEN_RANK}`,
    );
    await ds.query(`CREATE INDEX "IDX_TOKEN_RANK" ON token (rank)`);

    for (const [saleAddress, marketCap, age] of TOKENS) {
      await insertToken(saleAddress, marketCap, age);
    }
    await ds.query(OLD_REFRESH_SQL);
    // Created after the last tick, and an unlisted token with a stale rank.
    await insertToken('ct_fresh', BASE_CAP, 1);
    await ds.query(
      `UPDATE token SET unlisted = true WHERE sale_address = 'ct_low'`,
    );

    queryRunner = ds.createQueryRunner();
    await new TokenRankTable1718900000044().up(queryRunner);
    service = new RefreshTokenRanksService(ds);
  }, 60_000);

  afterAll(async () => {
    await queryRunner?.release();
    await db?.drop();
  }, 60_000);

  it('seeds every placed rank from token.rank', async () => {
    const seeded = await newRanks();

    expect(seeded).toEqual(await oldRanks());
    expect(seeded.map((row) => row.sale_address)).not.toContain('ct_fresh');
    // The exact tie shares rank 6, so ct_low follows at 8.
    expect(seeded).toContainEqual({ sale_address: 'ct_tie_b', rank: 6 });
    expect(seeded).toContainEqual({ sale_address: 'ct_low', rank: 8 });
  });

  it('creates the table exactly as the entity declares it', async () => {
    // token.rank and IDX_TOKEN_RANK are dropped by a later release.
    const pending = await ds.driver.createSchemaBuilder().log();
    expect(
      pending.upQueries.filter((query) => query.query.includes('token_rank')),
    ).toEqual([]);
  });

  it('places a token created since the last tick like the old refresh', async () => {
    await refreshBoth();

    expect(await newRanks()).toEqual(await oldRanks());
    expect(await newRanks()).toContainEqual({
      sale_address: 'ct_fresh',
      rank: 6,
    });
  });

  it('writes nothing, and locks nothing, when no rank changed', async () => {
    const tokenBefore = await versions('token');
    const ranksBefore = await versions('token_rank');

    await service.refreshRanks();

    expect(await versions('token_rank')).toEqual(ranksBefore);
    expect(ranksBefore.every((row) => row.xmax === '0')).toBe(true);
    expect(await versions('token')).toEqual(tokenBefore);
  });

  it('shifts every rank below a new token in the base-cap tie block', async () => {
    const before = await newRanks();
    await insertToken('ct_new', BASE_CAP, 0);

    await refreshBoth();

    const after = await newRanks();
    expect(after).toEqual(await oldRanks());
    const shifted = after.filter((row) => {
      const old = before.find((b) => b.sale_address === row.sale_address);
      return old && old.rank !== row.rank;
    });
    expect(shifted.map((row) => row.sale_address).sort()).toEqual([
      'ct_tie_a',
      'ct_tie_b',
      'ct_zero_1',
      'ct_zero_2',
    ]);
  });

  it('follows a trade that moves a token up the board', async () => {
    await ds.query(
      `UPDATE token SET market_cap = '70000000000000000000' WHERE sale_address = 'ct_base_2'`,
    );

    await refreshBoth();

    expect(await newRanks()).toEqual(await oldRanks());
    expect(await newRanks()).toContainEqual({
      sale_address: 'ct_base_2',
      rank: 2,
    });
  });

  it('leaves an unlisted token its last rank, as the old column did', async () => {
    await ds.query(
      `UPDATE token SET unlisted = true WHERE sale_address = 'ct_second'`,
    );

    await refreshBoth();

    expect(await newRanks()).toEqual(await oldRanks());
    expect(await newRanks()).toContainEqual({
      sale_address: 'ct_second',
      rank: 3,
    });
  });

  it('ranks a relisted token again', async () => {
    await ds.query(
      `UPDATE token SET unlisted = false WHERE sale_address IN ('ct_second', 'ct_low')`,
    );

    await refreshBoth();

    expect(await newRanks()).toEqual(await oldRanks());
  });

  it('drops the rank of a deleted token with the token', async () => {
    await ds.query(`DELETE FROM token WHERE sale_address = 'ct_top'`);

    expect((await newRanks()).map((row) => row.sale_address)).not.toContain(
      'ct_top',
    );
    await refreshBoth();
    expect(await newRanks()).toEqual(await oldRanks());
  });

  it('down() drops the table and leaves token.rank in place', async () => {
    await new TokenRankTable1718900000044().down(queryRunner);

    const [{ table }] = await ds.query(
      `SELECT to_regclass('token_rank') AS table`,
    );
    expect(table).toBeNull();
    expect((await oldRanks()).length).toBeGreaterThan(0);

    await new TokenRankTable1718900000044().up(queryRunner);
    expect(await newRanks()).toEqual(await oldRanks());
  });
});
