import 'dotenv/config';
import { QueryRunner } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { SocialGraphBackfillState1718900000029 } from '@/migrations/1718900000029-SocialGraphBackfillState';
import { SocialGraphBackfillState } from './social-graph-backfill-state.entity';

/**
 * DB-backed proof that the backfill watermark migration and entity agree: the
 * table is created, a row round-trips, the height starts NULL and updates in
 * place, and down() drops it. Requires the local Postgres (`DB_HOST`).
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('social_graph_backfill_state (migration + entity)', () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [SocialGraphBackfillState],
      migrations: [SocialGraphBackfillState1718900000029],
    });
    await db.dataSource.runMigrations();
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('round-trips the watermark: absent → NULL → set → advanced', async () => {
    const repo = db.dataSource.getRepository(SocialGraphBackfillState);
    const contract = 'ct_tC6G9MzysAvny8RBdq56oG3emgbUYEZhmfbaC3irfA8bbBJRS';

    expect(await repo.findOne({ where: { contract_address: contract } })).toBe(
      null,
    );

    await repo.save({
      contract_address: contract,
      last_backfilled_height: 1352517,
      updated_at: new Date(),
    });
    expect(
      (await repo.findOne({ where: { contract_address: contract } }))
        ?.last_backfilled_height,
    ).toBe(1352517);

    await repo.save({
      contract_address: contract,
      last_backfilled_height: 1400000,
      updated_at: new Date(),
    });
    const rows = await repo.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].last_backfilled_height).toBe(1400000);
  });

  it('down() drops the table', async () => {
    const qr: QueryRunner = db.dataSource.createQueryRunner();
    try {
      await new SocialGraphBackfillState1718900000029().down(qr);
      const exists = await qr.query(
        `SELECT to_regclass('social_graph_backfill_state') AS t`,
      );
      expect(exists[0].t).toBeNull();
    } finally {
      await qr.release();
    }
  });
});
