/**
 * The X explorer against a REAL PostgreSQL.
 *
 * Why this exists separately from the unit spec: that one mocks the query
 * builder, so it proves the shaping logic and nothing about the SQL. It cannot
 * catch a column that does not exist, an `IN (:...addresses)` that fails to
 * expand, a nullable mismatch, or an ordering clause Postgres rejects. Those
 * are exactly the faults that would take the dashboard down in front of an
 * operator mid-incident.
 *
 * It also closes the gap nobody else covers: the reward pipeline writes payouts
 * into four different tables, and until now nothing asserted that a payout
 * written the way the pipeline writes it comes back out of the dashboard
 * correctly attributed, totalled and linked. Before arming real money, that is
 * the property worth having under test.
 */
import { DataSource, Repository } from 'typeorm';

import { ProfileXInvite } from '@/profile/entities/profile-x-invite.entity';
import { ProfileXInviteMilestoneReward } from '@/profile/entities/profile-x-invite-milestone-reward.entity';
import { ProfileXPostingReward } from '@/profile/entities/profile-x-posting-reward.entity';
import { ProfileXPostRewardLedger } from '@/profile/entities/profile-x-post-reward-ledger.entity';
import { ProfileXStreakBonusReward } from '@/profile/entities/profile-x-streak-bonus-reward.entity';
import {
  findPostgresBinDir,
  startPostgres,
  PostgresHandle,
} from '@/test/reward-e2e/postgres';
import { BclAffiliationAnalyticsService } from './bcl-affiliation-analytics.service';

const PAID_ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
const STALLED_ADDRESS = 'ak_gAWT7XdGs2wtyCMPJe1K1SneofRFeDGf6Sp5ueftdev36XwHH';
const ONBOARDING_TX = 'th_2onboardingHashAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const STREAK_TX = 'th_2streakHashBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

let pg: PostgresHandle | null = null;
let ds: DataSource;

/**
 * Decided synchronously at module load so Jest can REPORT these as skipped.
 *
 * Returning early from inside each test instead would have Jest record them as
 * PASSING, so a machine without a database reports five green tests that
 * executed nothing. That is the precise failure mode this suite exists to
 * catch, and an earlier version of this file shipped it — caught in review.
 */
const binDir = findPostgresBinDir();
const describeWithDb = binDir ? describe : describe.skip;

function makeService(dataSource: DataSource) {
  const repo = <T>(e: any): Repository<T> => dataSource.getRepository(e);
  const unused = () => ({}) as any;
  return new BclAffiliationAnalyticsService(
    unused(), // invitationRepo — not read by getXExplorerData
    unused(), // txRepo — likewise
    repo(ProfileXInvite),
    repo(ProfileXPostingReward),
    repo(ProfileXPostRewardLedger),
    repo(ProfileXStreakBonusReward),
    repo(ProfileXInviteMilestoneReward),
  );
}

async function seed(dataSource: DataSource) {
  // A wallet that linked X, qualified, and was paid the onboarding reward the
  // way the pipeline actually writes it: tx_hash and status on the reward row
  // itself, NOT a ledger row.
  await dataSource.getRepository(ProfileXPostingReward).save([
    {
      address: PAID_ADDRESS,
      x_username: 'paid_user',
      x_user_id: '111',
      verified_at: new Date('2026-06-24T00:00:00.000Z'),
      referral_code: 'paidcode1234',
      follower_count: 5000,
      follower_tier_index: 1,
      qualified_posts_count: 12,
      current_streak_days: 10,
      last_x_api_scan_at: new Date('2026-09-01T00:00:00.000Z'),
      status: 'paid',
      tx_hash: ONBOARDING_TX,
      error: null,
    },
    {
      // Linked and never scanned — the state seen live on production.
      address: STALLED_ADDRESS,
      x_username: 'never_scanned',
      x_user_id: null,
      verified_at: new Date('2026-06-23T00:00:00.000Z'),
      referral_code: null,
      follower_count: null,
      qualified_posts_count: 0,
      current_streak_days: 0,
      last_x_api_scan_at: null,
      status: 'pending',
      tx_hash: null,
      error: null,
    },
  ] as any);

  await dataSource.getRepository(ProfileXStreakBonusReward).save({
    address: PAID_ADDRESS,
    x_user_id: '111',
    streak_length: 10,
    streak_completed_day: '2026-07-04',
    amount_aettos: '50000000000000000000', // 50 AE
    status: 'paid',
    tx_hash: STREAK_TX,
    error: null,
  } as any);

  await dataSource.getRepository(ProfileXPostRewardLedger).save({
    address: PAID_ADDRESS,
    x_user_id: '111',
    tweet_id: '900001',
    tweet_utc_day: '2026-07-02',
    reward_kind: 'per_post',
    amount_aettos: '10000000000000000000', // 10 AE
    status: 'paid',
    tx_hash: 'th_2perPostHashCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    error: null,
  } as any);

  await dataSource.getRepository(ProfileXInvite).save({
    inviter_address: PAID_ADDRESS,
    invitee_address: null,
    code: 'openinvite01',
    status: 'active',
    bound_at: null,
  } as any);
}

describeWithDb('X explorer against real PostgreSQL', () => {
  beforeAll(async () => {
    // Throws if the binary is present but will not start. That is a real
    // problem, not an absent environment, and must not be silently skipped.
    pg = await startPostgres(binDir as string);
    ds = new DataSource({
      type: 'postgres',
      url: pg.url,
      entities: [
        ProfileXPostingReward,
        ProfileXPostRewardLedger,
        ProfileXStreakBonusReward,
        ProfileXInvite,
        ProfileXInviteMilestoneReward,
      ],
      synchronize: true,
      logging: false,
    });
    await ds.initialize();
    // Seeded here, not inside the first test: a case that only passes because
    // another happened to run before it is not a test, and `-t` on any single
    // one below would have failed.
    await seed(ds);
  }, 120000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    pg?.stop();
  });

  it('runs every explorer query against the real engine', async () => {
    // The whole point: if any column, join or parameter expansion is wrong,
    // this throws instead of quietly returning a shaped-but-empty object.
    const result = await makeService(ds).getXExplorerData({});

    expect(result.users.length + result.pending.length).toBe(2);
  });

  it('reports a real paid wallet with every payout attributed and linked', async () => {
    const result = await makeService(ds).getXExplorerData({});

    const paid = result.users.find((u) => u.address === PAID_ADDRESS);
    expect(paid).toBeDefined();

    const kinds = (paid?.payouts || []).map((p) => p.kind).sort();
    // All three programs that paid this wallet, from three different tables.
    expect(kinds).toEqual(['onboarding', 'per_post', 'streak_bonus']);

    const streak = paid?.payouts.find((p) => p.kind === 'streak_bonus');
    expect(streak?.amount_ae).toBe('50');
    expect(streak?.status).toBe('paid');
    expect(streak?.explorer_url).toBe(
      `${result.explorer_base_url}/transactions/${STREAK_TX}`,
    );

    // The onboarding payout is the one that lives on the reward row rather
    // than in a ledger, and was missing entirely until review caught it.
    const onboarding = paid?.payouts.find((p) => p.kind === 'onboarding');
    expect(onboarding?.status).toBe('paid');
    expect(onboarding?.explorer_url).toBe(
      `${result.explorer_base_url}/transactions/${ONBOARDING_TX}`,
    );

    expect(paid?.eligibility.eligible).toBe(true);
    expect(result.summary.payouts_paid).toBe(3);
    expect(result.summary.payouts_failed).toBe(0);
  });

  it('separates a never-scanned wallet from an eligible one', async () => {
    const result = await makeService(ds).getXExplorerData({});

    const stalled = [...result.users, ...result.pending].find(
      (u) => u.address === STALLED_ADDRESS,
    );
    expect(stalled?.eligibility.eligible).toBe(false);
    expect(stalled?.eligibility.label).toMatch(/never scanned/i);
    expect(stalled?.payouts).toEqual([]);
    expect(result.summary.never_scanned_users).toBe(1);
    expect(result.summary.eligible_users).toBe(1);
  });

  it('counts an unbound invite link without inventing an invitee', async () => {
    const result = await makeService(ds).getXExplorerData({});

    const paid = result.users.find((u) => u.address === PAID_ADDRESS);
    expect(paid?.invite_links_created).toBe(1);
    expect(paid?.invite_links_taken).toBe(0);
    expect(paid?.invitees[0].address).toBeNull();
    expect(paid?.invitees[0].invite_code).toBe('openinvite01');
    expect(result.summary.invite_links_created).toBe(1);
  });

  it('totals only settled AE, across all reward tables', async () => {
    const result = await makeService(ds).getXExplorerData({});

    const paid = result.users.find((u) => u.address === PAID_ADDRESS);
    // 50 (streak) + 10 (per-post) + the configured onboarding amount. Asserted
    // as "at least the two recorded amounts" because the onboarding figure
    // comes from config, which a deployment is free to change.
    expect(Number(paid?.total_ae_paid)).toBeGreaterThanOrEqual(60);
    expect(Number(result.summary.total_ae_paid)).toBeGreaterThanOrEqual(60);
  });
});
