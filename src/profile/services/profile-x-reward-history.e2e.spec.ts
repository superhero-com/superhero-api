/**
 * The user-facing reward history against a REAL PostgreSQL.
 *
 * Payouts are sent automatically, so this list is how a user checks they got
 * paid. Rows are seeded the way the payout pipeline writes them — the
 * onboarding payout on the reward row, the rest in their own tables — and the
 * test asserts each one comes back attributed, dated and linked, and that
 * nothing unpaid or private leaks into it.
 */
import { DataSource, Repository } from 'typeorm';

import { ProfileXInviteMilestoneReward } from '@/profile/entities/profile-x-invite-milestone-reward.entity';
import { ProfileXPostingReward } from '@/profile/entities/profile-x-posting-reward.entity';
import { ProfileXPostRewardLedger } from '@/profile/entities/profile-x-post-reward-ledger.entity';
import { ProfileXStreakBonusReward } from '@/profile/entities/profile-x-streak-bonus-reward.entity';
import { PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE } from '@/profile/profile.constants';
import {
  findPostgresBinDir,
  startPostgres,
  PostgresHandle,
} from '@/test/reward-e2e/postgres';
import { ProfileXRewardHistoryService } from './profile-x-reward-history.service';

const PAID = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
const LINKED_ONLY = 'ak_gAWT7XdGs2wtyCMPJe1K1SneofRFeDGf6Sp5ueftdev36XwHH';
const STRANGER = 'ak_2swhLkgBPeeADxVTAVCJnZLY5NZtCFiM93JxsEaMuC59euuFRQ';

const ONBOARDING_TX = 'th_2onboardingHashAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POST_TX = 'th_2perPostHashCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const STREAK_TX = 'th_2streakHashBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MILESTONE_TX = 'th_2inviteHashDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
// What the payout services write into tx_hash while a send is mid-flight.
const IN_FLIGHT_SENTINEL = 'claimed:1726900000000';

let pg: PostgresHandle | null = null;
let ds: DataSource;

// Decided at module load so Jest reports these as SKIPPED, not passing, on a
// machine without Postgres. See bcl-affiliation-x-explorer.e2e.spec.ts.
const binDir = findPostgresBinDir();
const describeWithDb = binDir ? describe : describe.skip;

function makeService(dataSource: DataSource) {
  const repo = <T>(e: any): Repository<T> => dataSource.getRepository(e);
  return new ProfileXRewardHistoryService(
    repo(ProfileXPostingReward),
    repo(ProfileXPostRewardLedger),
    repo(ProfileXStreakBonusReward),
    repo(ProfileXInviteMilestoneReward),
  );
}

async function seed(dataSource: DataSource) {
  await dataSource.getRepository(ProfileXPostingReward).save([
    {
      address: PAID,
      x_username: 'paid_user',
      x_user_id: '111',
      verified_at: new Date('2026-06-24T00:00:00.000Z'),
      qualified_posts_count: 12,
      status: 'paid',
      tx_hash: ONBOARDING_TX,
      // An eligibility code a later scan wrote: must never reach the user.
      error: 'below_min_followers',
    },
    {
      // Linked X, never qualified. 'pending' here means "nothing earned yet",
      // not "a payout on its way".
      address: LINKED_ONLY,
      x_username: 'linked_only',
      x_user_id: '222',
      verified_at: new Date('2026-06-23T00:00:00.000Z'),
      qualified_posts_count: 0,
      status: 'pending',
      tx_hash: null,
      error: null,
    },
  ] as any);

  const ledger = dataSource.getRepository(ProfileXPostRewardLedger);
  await ledger.save([
    {
      address: PAID,
      x_user_id: '111',
      tweet_id: '900001',
      tweet_utc_day: '2026-07-02',
      reward_kind: 'per_post',
      amount_aettos: '10000000000000000000', // 10 AE
      status: 'paid',
      tx_hash: POST_TX,
    },
    {
      // Mid-send: a sentinel in tx_hash, status never reset from 'failed'.
      address: PAID,
      x_user_id: '111',
      tweet_id: '900002',
      tweet_utc_day: '2026-07-03',
      reward_kind: 'per_post',
      amount_aettos: '1500000000000000000', // 1.5 AE
      status: 'failed',
      tx_hash: IN_FLIGHT_SENTINEL,
    },
    {
      // Terminal and never sent: not something the user got.
      address: PAID,
      x_user_id: '111',
      tweet_id: '900003',
      tweet_utc_day: '2026-07-04',
      reward_kind: 'per_post',
      amount_aettos: 'not-a-number',
      status: 'skipped',
      tx_hash: null,
    },
    {
      address: STRANGER,
      x_user_id: '333',
      tweet_id: '900004',
      tweet_utc_day: '2026-07-02',
      reward_kind: 'per_post',
      amount_aettos: '10000000000000000000',
      status: 'paid',
      tx_hash: 'th_2strangerHashEEEEEEEEEEEEEEEEEEEEEEEEEEEE',
    },
  ] as any);
  // created_at is the history's clock; set it explicitly so ordering is real.
  await ledger.query(
    `UPDATE profile_x_post_reward_ledger SET created_at = ('2026-' || CASE tweet_id
       WHEN '900001' THEN '07-02' WHEN '900002' THEN '07-03'
       WHEN '900003' THEN '07-04' ELSE '07-02' END || 'T12:00:00')::timestamp`,
  );

  await dataSource.getRepository(ProfileXStreakBonusReward).save({
    address: PAID,
    x_user_id: '111',
    streak_length: 10,
    streak_completed_day: '2026-07-04',
    amount_aettos: '50000000000000000000', // 50 AE
    status: 'paid',
    tx_hash: STREAK_TX,
    created_at: new Date('2026-07-05T08:00:00.000Z'),
  } as any);

  await dataSource.getRepository(ProfileXInviteMilestoneReward).save({
    inviter_address: PAID,
    threshold: 10,
    status: 'paid',
    tx_hash: MILESTONE_TX,
    created_at: new Date('2026-07-06T09:00:00.000Z'),
  } as any);
}

describeWithDb('X reward history against real PostgreSQL', () => {
  beforeAll(async () => {
    pg = await startPostgres(binDir as string);
    ds = new DataSource({
      type: 'postgres',
      url: pg.url,
      entities: [
        ProfileXPostingReward,
        ProfileXPostRewardLedger,
        ProfileXStreakBonusReward,
        ProfileXInviteMilestoneReward,
      ],
      synchronize: true,
      logging: false,
    });
    await ds.initialize();
    await seed(ds);
  }, 120000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    pg?.stop();
  });

  it('lists every payout from all four tables, newest first', async () => {
    const { items, truncated } = await makeService(ds).getHistory(PAID);

    expect(items.map((i) => [i.kind, i.status])).toEqual([
      ['invite_milestone', 'paid'],
      ['streak_bonus', 'paid'],
      ['per_post', 'pending'],
      ['per_post', 'paid'],
      ['onboarding', 'paid'],
    ]);
    expect(truncated).toBe(false);
  });

  it('links each settled payout to the explorer, and never a sentinel', async () => {
    const { items } = await makeService(ds).getHistory(PAID);
    const byTx = (tx: string) => items.find((i) => i.tx_hash === tx);

    for (const tx of [ONBOARDING_TX, POST_TX, STREAK_TX, MILESTONE_TX]) {
      expect(byTx(tx)?.explorer_url).toMatch(
        new RegExp(`^https?://.+/transactions/${tx}$`),
      );
    }

    const inFlight = items.find(
      (i) => i.kind === 'per_post' && i.status === 'pending',
    );
    expect(inFlight?.tx_hash).toBeNull();
    expect(inFlight?.explorer_url).toBeNull();
    expect(JSON.stringify(items)).not.toContain(IN_FLIGHT_SENTINEL);
  });

  it('reports recorded amounts exactly, and says when an amount is config', async () => {
    const { items } = await makeService(ds).getHistory(PAID);

    const post = items.find((i) => i.tx_hash === POST_TX);
    expect(post).toMatchObject({
      amount_ae: '10',
      amount_recorded: true,
      post_day: '2026-07-02',
    });
    expect(
      items.find((i) => i.kind === 'per_post' && i.status === 'pending')
        ?.amount_ae,
    ).toBe('1.5');

    expect(items.find((i) => i.kind === 'streak_bonus')).toMatchObject({
      amount_ae: '50',
      amount_recorded: true,
      streak_days: 10,
    });

    expect(items.find((i) => i.kind === 'onboarding')).toMatchObject({
      amount_ae: PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE,
      amount_recorded: false,
      occurred_at: '2026-06-24T00:00:00.000Z',
    });
    expect(items.find((i) => i.kind === 'invite_milestone')).toMatchObject({
      amount_recorded: false,
      invite_count: 10,
    });
  });

  it('leaves out skipped rows and anything private', async () => {
    const { items } = await makeService(ds).getHistory(PAID);

    expect(items.some((i) => i.post_day === '2026-07-04')).toBe(false);
    const body = JSON.stringify(items);
    expect(body).not.toContain('below_min_followers');
    expect(body).not.toContain('paid_user');
    expect(body).not.toContain('900001');
  });

  it('shows nothing for a wallet that linked X but never earned', async () => {
    await expect(makeService(ds).getHistory(LINKED_ONLY)).resolves.toEqual({
      items: [],
      truncated: false,
    });
  });

  it('caps a long history and says there is more', async () => {
    const PROLIFIC = 'ak_prolificPosterWithManyRewards1111111111111111111';
    await ds.getRepository(ProfileXPostRewardLedger).save(
      Array.from({ length: 101 }, (_, i) => ({
        address: PROLIFIC,
        x_user_id: '444',
        tweet_id: `95${i}`,
        tweet_utc_day: null,
        reward_kind: 'per_post',
        amount_aettos: '1000000000000000000',
        status: 'paid',
        tx_hash: `th_2prolific${i}`,
      })) as any,
    );

    const { items, truncated } = await makeService(ds).getHistory(PROLIFIC);
    expect(items).toHaveLength(100);
    expect(truncated).toBe(true);
  });

  it("never returns another wallet's payouts", async () => {
    const { items } = await makeService(ds).getHistory(PAID);
    expect(JSON.stringify(items)).not.toContain('strangerHash');

    const stranger = await makeService(ds).getHistory(STRANGER);
    expect(stranger.items).toHaveLength(1);
  });
});
