import 'dotenv/config';
import { DataSource } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { PostSlugAndTokenUpperSymbolIndexes1718900000039 } from '@/migrations/1718900000039-PostSlugAndTokenUpperSymbolIndexes';
import { Token } from '@/tokens/entities/token.entity';
import { Post } from './post.entity';
import { Topic } from './topic.entity';

const d = process.env.DB_HOST ? describe : describe.skip;

const INDEX_NAMES = ['IDX_POSTS_SLUG', 'IDX_TOKEN_UPPER_SYMBOL'];

// Same SQL shapes TypeORM emits for PostsController.getById and
// attachTrendMentionsPerformance.
const POST_BY_ID_OR_SLUG = `SELECT * FROM "posts" "post" WHERE ("post"."id" = 'x' OR "post"."slug" = 'x')`;
const TOKENS_BY_MENTION = `SELECT * FROM "token" "token" WHERE "token"."unlisted" = false AND UPPER("token"."symbol") IN ('AE', 'WAE')`;

async function indexDefs(ds: DataSource): Promise<Record<string, string>> {
  const rows: Array<{ indexname: string; indexdef: string }> = await ds.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [INDEX_NAMES],
  );
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

// enable_seqscan = off makes the planner pick an index whenever one can serve
// the predicate, so a Seq Scan here means the index doesn't match the query.
async function planWithoutSeqScan(ds: DataSource, sql: string) {
  return ds.transaction(async (manager) => {
    await manager.query('SET LOCAL enable_seqscan = off');
    const rows: Array<{ 'QUERY PLAN': string }> = await manager.query(
      `EXPLAIN ${sql}`,
    );
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

d('PostSlugAndTokenUpperSymbolIndexes1718900000039 (integration)', () => {
  describe('migrations only (production)', () => {
    let db: IsolatedDb;
    let ds: DataSource;

    beforeAll(async () => {
      db = await createIsolatedDatabase({
        migrations: [PostSlugAndTokenUpperSymbolIndexes1718900000039],
        seedSql: [
          `CREATE TABLE "posts" ("id" character varying PRIMARY KEY, "slug" character varying)`,
          `CREATE TABLE "token" ("sale_address" character varying PRIMARY KEY, "symbol" character varying NOT NULL, "unlisted" boolean NOT NULL DEFAULT false)`,
        ],
      });
      ds = db.dataSource;
      await ds.runMigrations();
    }, 60_000);

    afterAll(async () => {
      if (db) await db.drop();
    }, 60_000);

    it('creates both indexes', async () => {
      const defs = await indexDefs(ds);
      expect(defs.IDX_POSTS_SLUG).toContain('USING btree (slug)');
      expect(defs.IDX_TOKEN_UPPER_SYMBOL).toContain(
        'USING btree (upper((symbol)::text))',
      );
    });

    it('serves both lookups from the new indexes', async () => {
      expect(await planWithoutSeqScan(ds, POST_BY_ID_OR_SLUG)).toContain(
        'IDX_POSTS_SLUG',
      );
      expect(await planWithoutSeqScan(ds, TOKENS_BY_MENTION)).toContain(
        'IDX_TOKEN_UPPER_SYMBOL',
      );
    });

    it('drops both indexes on revert', async () => {
      await ds.undoLastMigration();
      expect(await indexDefs(ds)).toEqual({});
    });
  });

  describe('alongside DB_SYNC=true', () => {
    let db: IsolatedDb;
    let ds: DataSource;

    beforeAll(async () => {
      db = await createIsolatedDatabase({
        entities: [Post, Topic, Token],
        migrations: [PostSlugAndTokenUpperSymbolIndexes1718900000039],
      });
      ds = db.dataSource;
      // An already-synced dev database, then a deploy of this change: the
      // Docker image runs migrations before the app synchronizes on boot.
      await ds.synchronize();
      await ds.runMigrations();
      await ds.synchronize();
    }, 60_000);

    afterAll(async () => {
      if (db) await db.drop();
    }, 60_000);

    it('keeps both indexes after synchronize runs again', async () => {
      expect(Object.keys(await indexDefs(ds)).sort()).toEqual(INDEX_NAMES);
    });

    it('leaves synchronize nothing to change on these indexes', async () => {
      const pending = await ds.driver.createSchemaBuilder().log();
      const touching = [...pending.upQueries, ...pending.downQueries]
        .map((q) => q.query)
        .filter((q) => INDEX_NAMES.some((name) => q.includes(name)));
      expect(touching).toEqual([]);
    });
  });
});
