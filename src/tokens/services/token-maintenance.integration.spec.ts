import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { DataSource, EntitySchema, EntityManager } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { TokenRankTable1718900000044 } from '@/migrations/1718900000044-TokenRankTable';
import { Token } from '../entities/token.entity';
import { RefreshTokenRanksService } from './refresh-token-ranks.service';

const d = process.env.DB_HOST ? describe : describe.skip;

// Only the columns used by these maintenance operations; real repositories,
// transactions and PostgreSQL advisory/row locks are exercised below.
const tokenSchema = new EntitySchema({
  name: 'Token',
  target: Token,
  tableName: 'token',
  columns: {
    sale_address: { type: String, primary: true },
    dao_address: { type: String, nullable: true },
    market_cap: { type: Number },
    created_at: { type: Date },
    unlisted: { type: Boolean },
    rank: { type: Number },
  },
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

d('Token maintenance concurrency', () => {
  let db: IsolatedDb;
  let errors: jest.SpyInstance;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      migrations: [],
      entities: [tokenSchema],
      seedSql: [
        `CREATE TABLE token (
          sale_address text PRIMARY KEY, dao_address text, market_cap integer,
          created_at timestamp, unlisted boolean, rank integer
        )`,
      ],
    });
    const runner = db.dataSource.createQueryRunner();
    try {
      await new TokenRankTable1718900000044().up(runner);
    } finally {
      await runner.release();
    }
  }, 30_000);

  beforeEach(async () => {
    errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await db.dataSource.query('TRUNCATE token, token_rank');
    await db.dataSource.query(`INSERT INTO token VALUES
      ('ct_incomplete', NULL, 100, '2026-01-01', false, 77),
      ('ct_b', 'ct_dao_b', 200, '2026-01-01', false, 77),
      ('ct_c', 'ct_dao_c', 200, '2026-01-01', false, 77),
      ('ct_zero', 'ct_dao_zero', 0, '2026-01-01', false, 77),
      ('ct_hidden', 'ct_dao_hidden', 999, '2026-01-01', true, 77),
      ('ct_hidden_incomplete', NULL, 999, '2026-01-01', true, 77)`);
    await db.dataSource.query(
      'INSERT INTO token_rank (sale_address, rank) SELECT sale_address, rank FROM token',
    );
  });

  afterEach(() => errors.mockRestore());
  afterAll(async () => {
    await db?.drop();
  });

  function rankService(
    transaction = db.dataSource.transaction.bind(db.dataSource),
  ) {
    return new RefreshTokenRanksService({ transaction } as DataSource);
  }

  function heldRefresh(rollback = false) {
    const prepared = latch();
    const release = latch();
    const transaction = async (work: (manager: EntityManager) => unknown) =>
      db.dataSource.transaction(async (manager) => {
        await manager.query("SET LOCAL statement_timeout = '2s'");
        const result = await work(manager);
        prepared.resolve();
        await release.promise;
        if (rollback) throw new Error('rollback fixture');
        return result;
      });
    return { service: rankService(transaction as any), prepared, release };
  }

  it('defers overlapping rank refreshes until a later run', async () => {
    const held = heldRefresh();
    const pending = held.service.refreshRanks();
    let timeout: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        held.prepared.promise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('first job did not prepare')),
            3_000,
          );
        }),
      ]);
      clearTimeout(timeout!);
      const next = rankService(async (work: any) =>
        db.dataSource.transaction(async (manager) => {
          await manager.query("SET LOCAL statement_timeout = '500ms'");
          return work(manager);
        }),
      );
      // Must finish successfully while the first transaction still owns its
      // locks. A blocked statement/error swallowed by rank refresh fails too.
      await next.refreshRanks();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timeout!);
      held.release.resolve();
      await pending;
    }

    await rankService().refreshRanks();
    expect(
      await db.dataSource.query(
        'SELECT sale_address, rank FROM token_rank ORDER BY sale_address',
      ),
    ).toEqual([
      { sale_address: 'ct_b', rank: 1 },
      { sale_address: 'ct_c', rank: 1 },
      { sale_address: 'ct_hidden', rank: 77 },
      { sale_address: 'ct_hidden_incomplete', rank: 77 },
      { sale_address: 'ct_incomplete', rank: 3 },
      { sale_address: 'ct_zero', rank: 4 },
    ]);
    expect(errors).not.toHaveBeenCalled();
  }, 10_000);

  it('rolls back ranks and releases the lock after a transaction failure', async () => {
    const held = heldRefresh(true);
    const pending = held.service.refreshRanks();
    try {
      await held.prepared.promise;
      await rankService().refreshRanks();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      held.release.resolve();
      await pending;
    }
    expect(errors).toHaveBeenCalledTimes(1);
    const rank = () =>
      db.dataSource.query(
        "SELECT rank FROM token_rank WHERE sale_address='ct_incomplete'",
      );
    expect(await rank()).toEqual([{ rank: 77 }]);
    await rankService().refreshRanks();
    expect(await rank()).toEqual([{ rank: 3 }]);
  }, 10_000);
});
