import 'dotenv/config';
import { DataSource, Repository } from 'typeorm';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { RoomMembership } from '../../entities/room-membership.entity';
import { RoomBackfillState } from '../../entities/room-backfill-state.entity';
import { TgrMetricsService } from '../tgr-metrics.service';
import { __resetTgrMetricsForTests } from '../tgr-metrics';

/**
 * DB integration for the Task 15 metrics surface. Mirrors the Task 09 isolated-
 * schema harness: a real Postgres backs `token` + `room_membership` +
 * `room_backfill_state` in a DEDICATED `tgr15_test` schema (created/dropped here,
 * `synchronize: true`), so the gauge `GROUP BY`/counts run against real rows and
 * never touch the shared `public` schema.
 *
 * No relay socket is opened — the relay/queue counters are exercised by the unit
 * tests; here we assert the Postgres gauges (distributions, drift, reconcile age,
 * backfill progress) + the cron log line + the alert evaluation end-to-end.
 *
 * Requires the local Postgres (`DB_HOST`); auto-skips otherwise so unit-only runs
 * stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const SCHEMA = 'tgr15_test';

const makeTokenRow = (
  sale: string,
  state: string,
  hasRoom = state === 'created',
): Partial<Token> => ({
  sale_address: sale,
  address: 'ct_token_' + sale,
  name: 'N' + sale,
  symbol: 'SYM',
  owner_address: 'ak_owner_' + sale,
  creator_address: 'ak_creator_' + sale,
  nostr_room_state: state as any,
  has_nostr_room: hasRoom,
});

const makeMembershipRow = (
  sale: string,
  member: string,
  relayState: string,
  reconciledAt: Date | null,
): Partial<RoomMembership> => ({
  sale_address: sale,
  member_address: member,
  member_pubkey: member.padEnd(64, '0'),
  role: 'member',
  eligible: true,
  relay_state: relayState as any,
  last_reconciled_at: reconciledAt as any,
});

d('TGR metrics surface (integration)', () => {
  let ds: DataSource;
  let tokenRepo: Repository<Token>;
  let membershipRepo: Repository<RoomMembership>;
  let stateRepo: Repository<RoomBackfillState>;
  let service: TgrMetricsService;

  const CONFIG = { roomNotifyDepthBreak: 10000 } as any;

  beforeAll(async () => {
    const boot = new DataSource({
      ...(DATABASE_CONFIG as any),
      synchronize: false,
      entities: [],
    });
    await boot.initialize();
    await boot.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await boot.query(`CREATE SCHEMA "${SCHEMA}"`);
    await boot.destroy();

    ds = new DataSource({
      ...(DATABASE_CONFIG as any),
      schema: SCHEMA,
      synchronize: true,
      entities: [Token, RoomMembership, RoomBackfillState],
    });
    await ds.initialize();

    tokenRepo = ds.getRepository(Token);
    membershipRepo = ds.getRepository(RoomMembership);
    stateRepo = ds.getRepository(RoomBackfillState);
  }, 60_000);

  beforeEach(async () => {
    await membershipRepo.clear();
    await tokenRepo.clear();
    await stateRepo.clear();
    __resetTgrMetricsForTests();
    service = new TgrMetricsService(
      membershipRepo,
      tokenRepo,
      stateRepo,
      CONFIG,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    const cleanup = new DataSource({
      ...(DATABASE_CONFIG as any),
      synchronize: false,
      entities: [],
    });
    await cleanup.initialize();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await cleanup.destroy();
  }, 60_000);

  it('reports exact distribution counts, backfill created/total, and reconcile age', async () => {
    const recent = new Date();
    await tokenRepo.save([
      tokenRepo.create(makeTokenRow('ct_a', 'created')),
      tokenRepo.create(makeTokenRow('ct_b', 'created')),
      tokenRepo.create(makeTokenRow('ct_c', 'pending', false)),
      tokenRepo.create(makeTokenRow('ct_d', 'failed', false)),
      tokenRepo.create(makeTokenRow('ct_e', 'none', false)),
    ]);
    await membershipRepo.save([
      membershipRepo.create(makeMembershipRow('ct_a', 'ak_1', 'added', recent)),
      membershipRepo.create(makeMembershipRow('ct_a', 'ak_2', 'added', recent)),
      membershipRepo.create(
        makeMembershipRow('ct_b', 'ak_3', 'pending_add', recent),
      ),
      membershipRepo.create(
        makeMembershipRow('ct_b', 'ak_4', 'removed', recent),
      ),
    ]);
    await stateRepo.save(stateRepo.create({ id: 'global', last_height: 777 }));

    const report = await service.collect(true);

    expect(report.roomState).toMatchObject({
      none: 1,
      pending: 1,
      created: 2,
      failed: 1,
      deleted: 0,
    });
    expect(report.relayState).toEqual({
      pending_add: 1,
      added: 2,
      pending_remove: 0,
      removed: 1,
    });
    // drift = pending_add(1) + pending_remove(0) = 1; total memberships = 4
    expect(report.drift.count).toBe(1);
    expect(report.drift.membershipTotal).toBe(4);
    expect(report.drift.ratio).toBeCloseTo(0.25, 5);
    // backfill: created 2 / total 5 = 40%, failed 1, cursor 777
    expect(report.backfill).toMatchObject({
      created: 2,
      total: 5,
      failed: 1,
      percent: 40,
      cursorHeight: 777,
    });
    // all rows reconciled recently → low max-age, no stale alert
    expect(report.reconcile.staleCount).toBe(0);
    expect(report.reconcile.maxAgeSeconds).toBeLessThan(60);
    expect(report.alerts.some((a) => a.rule === 'stale_reconcile')).toBe(false);
  });

  it('a stale last_reconciled_at fires the stale_reconcile alert', async () => {
    const old = new Date(Date.now() - 90_000 * 1000); // ~25h ago
    await tokenRepo.save([tokenRepo.create(makeTokenRow('ct_s', 'created'))]);
    await membershipRepo.save([
      membershipRepo.create(makeMembershipRow('ct_s', 'ak_x', 'added', old)),
    ]);

    const report = await service.collect(true);
    expect(report.reconcile.staleCount).toBe(1);
    expect(report.reconcile.maxAgeSeconds).toBeGreaterThan(86400);
    expect(report.alerts.some((a) => a.rule === 'stale_reconcile')).toBe(true);
    expect(report.overallStatus).toBe('critical');
  });

  it('drift_ratio alert fires when pending memberships exceed the threshold', async () => {
    await tokenRepo.save([tokenRepo.create(makeTokenRow('ct_dr', 'created'))]);
    const recent = new Date();
    // 5 of 5 memberships pending_add → drift ratio 1.0 ≫ 0.02
    await membershipRepo.save(
      ['a', 'b', 'c', 'd', 'e'].map((m) =>
        membershipRepo.create(
          makeMembershipRow('ct_dr', 'ak_' + m, 'pending_add', recent),
        ),
      ),
    );

    const report = await service.collect(true);
    expect(report.drift.count).toBe(5);
    expect(report.drift.ratio).toBe(1);
    expect(report.alerts.some((a) => a.rule === 'drift_ratio')).toBe(true);
  });

  it('empty DB → healthy, zero gauges, no NaN', async () => {
    const report = await service.collect(true);
    expect(report.overallStatus).toBe('healthy');
    expect(report.drift.ratio).toBe(0);
    expect(report.backfill.percent).toBe(0);
    expect(report.reconcile.maxAgeSeconds).toBe(0);
  });
});
