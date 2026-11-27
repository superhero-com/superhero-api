import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { ShortsChainIndexing1791676800001 } from '../1791676800001-ShortsChainIndexing';

const integration = process.env.DB_HOST ? describe : describe.skip;

integration('Grouped feature migration history', () => {
  const feature = new ShortsChainIndexing1791676800001();
  let db: IsolatedDb;

  beforeEach(async () => {
    db = await createIsolatedDatabase({
      migrations: [ShortsChainIndexing1791676800001],
      migrationsTableName: 'feature_history',
      seedSql: ['CREATE TABLE txs (hash varchar PRIMARY KEY, data jsonb)'],
    });
  });
  afterEach(async () => db?.drop());

  it('records and reverts one migration on a new database', async () => {
    const applied = await db.dataSource.runMigrations();
    expect(applied.map((m) => m.name)).toEqual([feature.constructor.name]);
    expect(await db.dataSource.runMigrations()).toEqual([]);
    await db.dataSource.undoLastMigration();
    expect(
      await db.dataSource.query(
        "SELECT to_regclass('shorts_index_backfill') AS relation",
      ),
    ).toEqual([{ relation: null }]);
  });
});
