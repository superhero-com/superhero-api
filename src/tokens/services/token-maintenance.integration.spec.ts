import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { DataSource, EntitySchema, EntityManager } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '../entities/token.entity';
import { TokensService } from '../tokens.service';
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
  }, 30_000);

  beforeEach(async () => {
    errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await db.dataSource.query('TRUNCATE token');
    await db.dataSource.query(`INSERT INTO token VALUES
      ('ct_incomplete', NULL, 100, '2026-01-01', false, 77),
      ('ct_b', 'ct_dao_b', 200, '2026-01-01', false, 77),
      ('ct_c', 'ct_dao_c', 200, '2026-01-01', false, 77),
      ('ct_zero', 'ct_dao_zero', 0, '2026-01-01', false, 77),
      ('ct_hidden', 'ct_dao_hidden', 999, '2026-01-01', true, 77),
      ('ct_hidden_incomplete', NULL, 999, '2026-01-01', true, 77)`);
  });

  afterEach(() => errors.mockRestore());
  afterAll(async () => {
    await db?.drop();
  });

  function operations(
    transaction = db.dataSource.transaction.bind(db.dataSource),
  ) {
    const repository = db.dataSource.getRepository(Token);
    const scopedRepository = new Proxy(repository, {
      get(target, key) {
        if (key === 'manager') return { transaction };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const cleanup = new TokensService(
      scopedRepository,
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
    const rank = new RefreshTokenRanksService({ transaction } as DataSource);
    return {
      cleanup: () => cleanup.deleteTokensWhereDaoAddressIsNull(),
      rank: () => rank.refreshRanks(),
    };
  }

  function heldOperations(rollback = false) {
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
    return { actions: operations(transaction as any), prepared, release };
  }

  it.each([
    ['rank', 'cleanup'],
    ['cleanup', 'rank'],
    ['rank', 'rank'],
  ] as const)(
    'defers %s overlap with %s until a later run',
    async (first, second) => {
      const held = heldOperations();
      const pending = held.actions[first]();
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
        const next = operations(async (work: any) =>
          db.dataSource.transaction(async (manager) => {
            await manager.query("SET LOCAL statement_timeout = '500ms'");
            return work(manager);
          }),
        );
        // Must finish successfully while the first transaction still owns its
        // locks. A blocked statement/error swallowed by rank refresh fails too.
        await next[second]();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timeout!);
        held.release.resolve();
        await pending;
      }

      const next = operations();
      await next.cleanup();
      await next.rank();
      expect(
        await db.dataSource.query(
          'SELECT sale_address, rank FROM token ORDER BY sale_address',
        ),
      ).toEqual([
        { sale_address: 'ct_b', rank: 1 },
        { sale_address: 'ct_c', rank: 1 },
        { sale_address: 'ct_hidden', rank: 77 },
        { sale_address: 'ct_zero', rank: 3 },
      ]);
      expect(errors).not.toHaveBeenCalled();
    },
    10_000,
  );

  it('rolls back cleanup and releases the lock after a transaction failure', async () => {
    const held = heldOperations(true);
    const failed = held.actions.cleanup();
    const rejection = expect(failed).rejects.toThrow('rollback fixture');
    try {
      await held.prepared.promise;
      await operations().rank();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      held.release.resolve();
      await rejection;
    }
    expect(
      await db.dataSource.query('SELECT count(*)::int AS count FROM token'),
    ).toEqual([{ count: 6 }]);
    await operations().rank();
    expect(
      await db.dataSource.query(
        "SELECT rank FROM token WHERE sale_address='ct_incomplete'",
      ),
    ).toEqual([{ rank: 3 }]);
  }, 10_000);
});
