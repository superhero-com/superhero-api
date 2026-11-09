import { Migration, MigrationExecutor } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { ShortsChainIndexing1791676800001 } from '../1791676800001-ShortsChainIndexing';

const integration = process.env.DB_HOST ? describe : describe.skip;

integration('Grouped feature migration history', () => {
  const feature = new ShortsChainIndexing1791676800001();
  const first = 'ShortsChainIndex1791676800000';
  let db: IsolatedDb;

  beforeEach(async () => {
    db = await createIsolatedDatabase({
      migrations: [ShortsChainIndexing1791676800001],
      migrationsTableName: 'feature_history',
      seedSql: ['CREATE TABLE txs (hash varchar PRIMARY KEY, data jsonb)'],
    });
  });
  afterEach(async () => db?.drop());

  // Exercise the same TypeORM history entries that a prior app version wrote.
  async function applyPrevious(name: keyof typeof feature.changes) {
    await db.dataSource.transaction(async (manager) => {
      const executor = new MigrationExecutor(
        db.dataSource,
        manager.queryRunner,
      );
      await executor.executeMigration(
        new Migration(
          undefined,
          Number(name.slice(-13)),
          name,
          feature.changes[name],
        ),
      );
    });
  }

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

  it('finishes a partial upgrade and leaves inherited tables in place on revert', async () => {
    await applyPrevious(first);
    await db.dataSource.query(
      "INSERT INTO shorts_index_backfill(contract,version,complete) VALUES ('old',1,true)",
    );
    await db.dataSource.runMigrations();
    expect(
      await db.dataSource.query(
        "SELECT version,covered_height,complete FROM shorts_index_backfill WHERE contract='old'",
      ),
    ).toEqual([{ version: 1, covered_height: -1, complete: false }]);
    await db.dataSource.undoLastMigration();
    expect(
      await db.dataSource.query(
        "SELECT version FROM shorts_index_backfill WHERE contract='old'",
      ),
    ).toEqual([{ version: 1 }]);
    expect(
      await db.dataSource.query('SELECT name FROM feature_history'),
    ).toEqual([{ name: first }]);
  });

  it('adopts a fully migrated deployment without replaying data changes or reverting its binding', async () => {
    await applyPrevious(first);
    await applyPrevious('ShortsCoverage1791734400000');
    await applyPrevious('ShortsIndexNetwork1791763228000');
    await db.dataSource.query(
      "INSERT INTO shorts_index_backfill(contract,version,covered_height,complete) VALUES ('live',1,100,true)",
    );
    await db.dataSource.query(
      "INSERT INTO shorts_index_network(network) VALUES ('ae_uat')",
    );
    await db.dataSource.runMigrations();
    await db.dataSource.undoLastMigration();
    expect(
      await db.dataSource.query(
        "SELECT covered_height,complete FROM shorts_index_backfill WHERE contract='live'",
      ),
    ).toEqual([{ covered_height: 100, complete: true }]);
    expect(
      await db.dataSource.query('SELECT network FROM shorts_index_network'),
    ).toEqual([{ network: 'ae_uat' }]);
  });
});
