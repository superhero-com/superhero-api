import 'dotenv/config';
import { DataSource } from 'typeorm';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import { DropTransactionsTxHashDuplicateIndex1718900000043 } from '@/migrations/1718900000043-DropTransactionsTxHashDuplicateIndex';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Transaction } from './transaction.entity';

const d = process.env.DB_HOST ? describe : describe.skip;

const PRIMARY_KEY = 'PK_0deaa0ee5092d45fac99139de7c';
const DUPLICATE_INDEX = 'IDX_0deaa0ee5092d45fac99139de7';

// Matches on the definition, so a duplicate under any other name fails too.
async function txHashIndexes(ds: DataSource): Promise<string[]> {
  const rows: Array<{ indexname: string }> = await ds.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'transactions'
        AND indexdef LIKE '%(tx_hash)'
      ORDER BY indexname`,
  );
  return rows.map((r) => r.indexname);
}

function insertTransaction(ds: DataSource) {
  return ds.query(
    `INSERT INTO "transactions"
       ("tx_hash", "sale_address", "tx_type", "block_height", "address", "amount", "unit_price", "buy_price")
     VALUES ('th_1', 'ct_1', 'buy', 1, 'ak_1', '{}', '{}', '{}')`,
  );
}

d('DropTransactionsTxHashDuplicateIndex1718900000043 (integration)', () => {
  describe('migrations only (production)', () => {
    let db: IsolatedDb;
    let ds: DataSource;

    beforeAll(async () => {
      // The real base schema: DROP ... IF EXISTS would hide a wrong index name.
      db = await createIsolatedDatabase({
        migrations: [
          BaseSchema1718900000000,
          DropTransactionsTxHashDuplicateIndex1718900000043,
        ],
      });
      ds = db.dataSource;
      await ds.runMigrations();
    }, 60_000);

    afterAll(async () => {
      if (db) await db.drop();
    }, 60_000);

    it('leaves the primary key as the only tx_hash index', async () => {
      expect(await txHashIndexes(ds)).toEqual([PRIMARY_KEY]);
    });

    it('still serves tx_hash lookups from an index', async () => {
      // Same approach as post-slug-token-symbol-indexes.integration.spec.
      const plan: Array<{ 'QUERY PLAN': string }> = await ds.transaction(
        async (manager) => {
          await manager.query('SET LOCAL enable_seqscan = off');
          return manager.query(
            `EXPLAIN SELECT * FROM "transactions" WHERE "tx_hash" = 'th_1'`,
          );
        },
      );
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain(
        PRIMARY_KEY,
      );
    });

    it('still rejects a second row with the same tx_hash', async () => {
      await insertTransaction(ds);
      await expect(insertTransaction(ds)).rejects.toMatchObject({
        code: '23505',
        constraint: PRIMARY_KEY,
      });
    });

    it('restores the index on revert and drops it again on re-run', async () => {
      await ds.undoLastMigration();
      expect(await txHashIndexes(ds)).toEqual([DUPLICATE_INDEX, PRIMARY_KEY]);

      await ds.runMigrations();
      expect(await txHashIndexes(ds)).toEqual([PRIMARY_KEY]);
    });
  });

  describe('alongside DB_SYNC=true', () => {
    let db: IsolatedDb;

    afterAll(async () => {
      if (db) await db.drop();
    }, 60_000);

    it('does not recreate the index from the entity', async () => {
      db = await createIsolatedDatabase({
        entities: [Transaction],
        migrations: [DropTransactionsTxHashDuplicateIndex1718900000043],
      });
      const ds = db.dataSource;
      await ds.synchronize();
      await ds.runMigrations();
      await ds.synchronize();

      expect(await txHashIndexes(ds)).toEqual([PRIMARY_KEY]);
    }, 60_000);
  });
});
