import 'dotenv/config';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import {
  createIsolatedDatabase,
  MINIMAL_TOKEN_TABLE_SQL,
} from '@/test/harness/db';

const d = process.env.DB_HOST ? describe : describe.skip;

d('migrations', () => {
  it('apply in full to an empty database', async () => {
    const db = await createIsolatedDatabase({
      migrations: [__dirname + '/migrations/*.ts'],
    });
    try {
      const applied = await db.dataSource.runMigrations();
      expect(applied).toHaveLength(db.dataSource.migrations.length);
    } finally {
      await db.drop();
    }
  }, 120_000);

  it('skip the base schema on a database that already has tables', async () => {
    const db = await createIsolatedDatabase({
      migrations: [BaseSchema1718900000000],
      seedSql: [MINIMAL_TOKEN_TABLE_SQL],
    });
    try {
      await db.dataSource.runMigrations();
      const tables = await db.dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      expect(tables.map((t) => t.tablename)).toEqual(['migrations', 'token']);
    } finally {
      await db.drop();
    }
  }, 60_000);
});
