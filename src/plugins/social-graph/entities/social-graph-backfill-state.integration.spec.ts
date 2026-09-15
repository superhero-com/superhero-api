import 'dotenv/config';
import { QueryRunner } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { SocialGraphBackfillState1718900000029 } from '@/migrations/1718900000029-SocialGraphBackfillState';
import { SocialGraphBackfillResumeState1718900000030 } from '@/migrations/1718900000030-SocialGraphBackfillResumeState';
import { SocialGraphBackfillVersion1718900000031 } from '@/migrations/1718900000031-SocialGraphBackfillVersion';
import { SocialGraphBackfillState } from './social-graph-backfill-state.entity';

/**
 * DB-backed proof that the backfill state migrations and entity agree: the table
 * is created, a row round-trips, the watermark starts NULL and updates in place,
 * the resume columns round-trip too, and down() drops it. Requires the local
 * Postgres (`DB_HOST`).
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('social_graph_backfill_state (migration + entity)', () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [SocialGraphBackfillState],
      migrations: [
        SocialGraphBackfillState1718900000029,
        SocialGraphBackfillResumeState1718900000030,
        SocialGraphBackfillVersion1718900000031,
      ],
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

  it('round-trips the resume columns: in-progress values set then cleared', async () => {
    const repo = db.dataSource.getRepository(SocialGraphBackfillState);
    const contract = 'ct_resume_columns_roundtrip';

    // Absent columns default to NULL.
    await repo.save({
      contract_address: contract,
      last_backfilled_height: null,
      updated_at: new Date(),
    });
    const fresh = await repo.findOne({ where: { contract_address: contract } });
    expect(fresh?.resume_from_height).toBeNull();
    expect(fresh?.pending_high_height).toBeNull();

    // A truncated boot records where to resume and the top seen so far.
    await repo.save({
      contract_address: contract,
      last_backfilled_height: null,
      resume_from_height: 5051,
      pending_high_height: 5100,
      updated_at: new Date(),
    });
    const inProgress = await repo.findOne({
      where: { contract_address: contract },
    });
    expect(inProgress?.resume_from_height).toBe(5051);
    expect(inProgress?.pending_high_height).toBe(5100);

    // Completion promotes the top and clears the resume state.
    await repo.save({
      contract_address: contract,
      last_backfilled_height: 5100,
      resume_from_height: null,
      pending_high_height: null,
      updated_at: new Date(),
    });
    const done = await repo.findOne({ where: { contract_address: contract } });
    expect(done?.last_backfilled_height).toBe(5100);
    expect(done?.resume_from_height).toBeNull();
    expect(done?.pending_high_height).toBeNull();
  });

  it('round-trips the recovery version: absent → NULL → stamped', async () => {
    const repo = db.dataSource.getRepository(SocialGraphBackfillState);
    const contract = 'ct_version_roundtrip';

    // A row written before the version column existed reads NULL.
    await repo.save({
      contract_address: contract,
      last_backfilled_height: 1352517,
      updated_at: new Date(),
    });
    expect(
      (await repo.findOne({ where: { contract_address: contract } }))?.version,
    ).toBeNull();

    // A completed walk stamps the plugin version it recovered under.
    await repo.save({
      contract_address: contract,
      last_backfilled_height: 1352517,
      version: 2,
      updated_at: new Date(),
    });
    expect(
      (await repo.findOne({ where: { contract_address: contract } }))?.version,
    ).toBe(2);
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
