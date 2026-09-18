import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import moment from 'moment';
import BigNumber from 'bignumber.js';
import { toAe } from '@aeternity/aepp-sdk';
import { Invitation } from '../entities/invitation.entity';
import { ACTIVE_NETWORK } from '@/configs/network';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { ProfileXInvite } from '@/profile/entities/profile-x-invite.entity';
import { ProfileXInviteMilestoneReward } from '@/profile/entities/profile-x-invite-milestone-reward.entity';
import { ProfileXPostingReward } from '@/profile/entities/profile-x-posting-reward.entity';
import { ProfileXPostRewardLedger } from '@/profile/entities/profile-x-post-reward-ledger.entity';
import { ProfileXStreakBonusReward } from '@/profile/entities/profile-x-streak-bonus-reward.entity';
import {
  PROFILE_X_INVITE_LINK_BASE_URL,
  PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE,
  PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE,
  PROFILE_X_REFERRAL_LINK_BASE_URL,
  PROFILE_X_REWARD_MIN_FOLLOWERS,
  X_INFORMATIONAL_ERROR_CODES,
  isInformationalXError,
} from '@/profile/profile.constants';

export type BclAffiliationDailyPoint = {
  date: string; // YYYY-MM-DD
  registered: number;
  redeemed: number;
  revoked: number;
  amount_ae_registered: number;
};

export type BclAffiliationSummary = {
  total_registered: number;
  total_redeemed: number;
  total_revoked: number;
  total_outstanding: number;
  unique_inviters: number;
  unique_invitees: number;
  unique_redeemers: number;
  total_amount_ae_registered: number;
  avg_amount_ae_per_registered: number;
  avg_amount_ae_per_inviter: number;
  redeemed_rate: number; // redeemed / registered
  revoked_rate: number; // revoked / registered
};

export type BclAffiliationTopInviter = {
  inviter: string;
  registered_count: number;
  redeemed_count: number;
  revoked_count: number;
  pending_count: number;
  total_amount_ae: number;
};

export type BclXVerificationDailyPoint = {
  date: string; // YYYY-MM-DD
  daily_new_verified: number;
  cumulative_verified: number;
};

export type BclXVerificationSummary = {
  total_verified_users: number;
};

export type BclXInviteUsageDailyPoint = {
  date: string; // YYYY-MM-DD
  created_codes: number;
  invited_users: number;
};

export type BclXInviteUsageSummary = {
  total_created_codes: number;
  total_invited_users: number;
  invite_bind_rate: number;
};

/** One step of the X onboarding funnel, ordered widest to narrowest. */
export type BclXOnboardingStage = {
  key: string;
  label: string;
  count: number;
  /** Share of the `linked_x` cohort that reached this stage, 0..1. */
  rate: number;
};

/** Why a user in the cohort has not been paid yet. */
export type BclXOnboardingBlocker = {
  reason: string;
  count: number;
};

/**
 * One `?xInvite=` link a user created, and how far the person who took it got.
 *
 * Unbound links keep a null address on purpose: "a link is out and nobody has
 * taken it" is a state worth seeing, not one to hide.
 */
export type BclXExplorerInvitee = {
  address: string | null;
  x_username: string | null;
  verified_at: string | null;
  bound_at: string | null;
  /** `active` = link created, nobody bound it yet. `bound` = someone took it. */
  status: string;
  invite_code: string;
  invite_link: string;
};

/**
 * A wallet in the X flow, verified or still on the way.
 *
 * Two unrelated codes live on this record and must not be conflated:
 *
 * - `post_referral_code` / `post_referral_link` (`?ref=`) is the code the user
 *   puts in their own X POSTS. A matching post earns a per-post reward. It
 *   creates no person-to-person edge and nothing counts who saw it.
 * - `invite_*` (`?xInvite=`) is the invite-a-person link. Taking one writes a
 *   `profile_x_invites` row binding inviter to invitee, and that is the only
 *   edge the referral tree can be drawn from.
 *
 * Naming them both "referral" is what made an earlier version of this
 * dashboard read as broken: a user with a referral code sat next to a count of
 * zero referral links, which are two different true facts.
 */
export type BclXExplorerUser = {
  address: string;
  x_username: string | null;
  verified_at: string | null;
  post_referral_code: string | null;
  post_referral_link: string | null;
  follower_count: number | null;
  follower_tier_index: number | null;
  qualified_posts_count: number;
  current_streak_days: number;
  status: string;
  error: string | null;
  last_x_api_scan_at: string | null;
  created_at: string | null;
  invite_links_created: number;
  invite_links_taken: number;
  invitees: BclXExplorerInvitee[];
  eligibility: BclXExplorerEligibility;
  payouts: BclXExplorerPayout[];
  total_ae_paid: string;
  explorer_account_url: string;
};

/**
 * Why a wallet is or is not currently earning, in operator language.
 *
 * `ProfileXPostingRewardService.toPublicError` says the same thing to the user
 * in second person ("Your X account needs at least N followers"). This is the
 * other audience: it names the gate and the wallet's own numbers against it, so
 * "not eligible" is never a bare code you have to go look up.
 */
export type BclXExplorerEligibility = {
  eligible: boolean;
  /** Short verdict for the badge, e.g. "Not eligible — too few followers". */
  label: string;
  /** The measurement behind the verdict, e.g. "0 followers, needs 100". */
  detail: string | null;
  /** The raw pipeline code, kept so the page never hides the ground truth. */
  code: string | null;
};

/**
 * One on-chain payout attempt, from whichever reward table recorded it.
 *
 * `explorer_url` is null unless the hash is a real one. The payout services
 * park sentinel strings in `tx_hash` while a send is in flight
 * (`__streak_bonus_payout_in_progress__` and friends), and linking one of those
 * to a block explorer would produce a confident 404 — worse than showing
 * nothing. Requiring the `th_` prefix rejects every sentinel, including any
 * added after this was written.
 */
export type BclXExplorerPayout = {
  kind: 'onboarding' | 'per_post' | 'streak_bonus' | 'invite_milestone';
  label: string;
  amount_ae: string | null;
  status: string;
  tx_hash: string | null;
  explorer_url: string | null;
  created_at: string | null;
  /** What earned it, e.g. "10-day streak" or "5 invites". */
  detail: string | null;
  error: string | null;
};

export type BclXExplorerDailyPoint = {
  date: string;
  verified: number;
  invite_links: number;
};

/**
 * A real æternity transaction hash, as opposed to one of the in-progress
 * sentinels the payout services write into `tx_hash` while a send is mid-flight.
 * Every genuine hash is `th_`-prefixed base58; no sentinel is.
 */
/**
 * What a payout row's status actually is.
 *
 * The `status` column alone is not it. A retry never resets it: claiming a
 * payout writes an in-progress sentinel into `tx_hash`, and a broadcast whose
 * DB confirmation failed writes a real hash, and neither touches `status`. So a
 * row retrying after an earlier failure still reads 'failed', and ranking
 * status first prints "failed" next to a live explorer link. `tx_hash` is
 * written later in the lifecycle, so it wins — only a failed row carrying no
 * hash at all is a genuinely dead send.
 *
 * This lived inline on the onboarding branch while per-post, streak and
 * milestone copied `status` raw, so those three both mislabelled live sends and
 * inflated `payouts_failed`. One implementation, applied to all four.
 */
function payoutStatus(row: {
  status?: string | null;
  tx_hash?: string | null;
}): 'paid' | 'pending' | 'failed' {
  if (row.status === 'paid') return 'paid';
  if (row.tx_hash) return 'pending';
  if (row.status === 'failed') return 'failed';
  return 'pending';
}

function isRealTxHash(txHash: string | null | undefined): txHash is string {
  return !!txHash && /^th_[1-9A-HJ-NP-Za-km-z]+$/.test(txHash);
}

function explorerTxUrl(txHash: string | null | undefined): string | null {
  if (!isRealTxHash(txHash)) return null;
  const base = (ACTIVE_NETWORK?.explorerUrl || '').replace(/\/+$/, '');
  return base ? `${base}/transactions/${txHash}` : null;
}

function explorerAccountUrl(address: string): string {
  const base = (ACTIVE_NETWORK?.explorerUrl || '').replace(/\/+$/, '');
  return base ? `${base}/accounts/${address}` : '';
}

/**
 * Amounts are stored in aettos. Formatted here rather than in the browser
 * because 50 AE is 5e19 aettos — past Number.MAX_SAFE_INTEGER, so parsing it
 * as a JS number in the page would quietly round it.
 */
function aettosToAe(amountAettos: string | null | undefined): string | null {
  if (!amountAettos) return null;
  try {
    return new BigNumber(toAe(amountAettos)).toFixed();
  } catch {
    return null;
  }
}

/**
 * The `?ref=` link a user drops into their X posts, built the way
 * `ProfileXPostingRewardService.buildReferralLink` builds it — the dashboard
 * must show the string the user was actually handed, not an approximation.
 */
function buildPostReferralLink(code: string): string {
  if (!PROFILE_X_REFERRAL_LINK_BASE_URL) return code;
  const base = PROFILE_X_REFERRAL_LINK_BASE_URL.replace(/\/+$/, '');
  return `${base}?ref=${encodeURIComponent(code)}`;
}

/**
 * The `?xInvite=` link, mirroring `ProfileXInviteService.buildInviteLink`,
 * including its fallback of returning the bare code when the base URL is
 * unset — which is what a deployment missing PROFILE_X_INVITE_LINK_BASE_URL
 * actually gave the user.
 */
/**
 * Turn a pipeline error code into an operator-readable verdict.
 *
 * The codes come from `ProfileXPostingRewardService`; the follower threshold is
 * read from the same constant the gate itself uses, so if
 * PROFILE_X_REWARD_MIN_FOLLOWERS changes the dashboard follows rather than
 * printing a stale number. The raw code travels alongside the prose — an
 * operator debugging a wallet needs the string that is actually in the column.
 */
function describeEligibility(
  reward: ProfileXPostingReward,
): BclXExplorerEligibility {
  const code = reward.error ?? null;
  const followers = reward.follower_count;
  const paid = reward.status === 'paid';

  // A truncated scan is a COMPLETED check that hit the per-check post limit.
  // It sits in `error` but is not a failure, and calling it one here would
  // repeat a bug already fixed twice in this pipeline.
  if (isInformationalXError(code)) {
    return {
      eligible: true,
      label: 'Eligible',
      detail: 'Latest scan hit the per-check post limit',
      code,
    };
  }

  // `status` and `error` describe DIFFERENT moments, and an earlier version of
  // this function read `status === 'paid'` as "currently fine" and discarded
  // the code. It is not: the onboarding payout sets status='paid' once and it
  // stays there forever, while every later scan overwrites `error` on the same
  // row (reconcileConfirmationPending says so in its own comment — tx_hash and
  // status persist, error does not). So a wallet that was paid and has since
  // dropped below the follower gate carries both, and treating paid as healthy
  // hid exactly the wallets that stopped qualifying. The error decides the
  // verdict; being paid only colours it.
  if (!code) {
    // No error is NOT the same as no problem. Nothing evaluates these rewards
    // on a schedule: the only thing that scans an X account is the user
    // pressing "Check rewards", which signs a challenge and calls the recheck
    // endpoint. A wallet that linked X and never came back has never been
    // looked at — null scan timestamp, null follower count — and calling that
    // "Eligible" is the same "unknown looks healthy" failure the default case
    // below exists to prevent. Observed live: a wallet linked on-chain in June
    // still had no scan of any kind months later.
    if (!paid && !reward.last_x_api_scan_at) {
      return {
        eligible: false,
        label: 'Not evaluated — never scanned',
        detail: 'Linked X, but no check has ever run for this wallet',
        code: null,
      };
    }
    return {
      eligible: true,
      label: 'Eligible',
      detail: paid ? 'Paid; no blocker recorded' : 'No blocker recorded',
      code: null,
    };
  }

  switch (code) {
    case 'below_min_followers':
      return {
        eligible: false,
        label: 'Not eligible — too few followers',
        detail:
          `${followers ?? 0} followers, needs ${PROFILE_X_REWARD_MIN_FOLLOWERS}` +
          // Worth saying out loud: this wallet HAS been paid and has since
          // stopped qualifying, which is a different situation from one that
          // never qualified at all.
          (paid ? ' (was paid earlier, no longer qualifying)' : ''),
        code,
      };
    case 'follower_count_unavailable':
      return {
        eligible: false,
        label: 'Not eligible — follower count unreadable',
        detail: `X did not return a follower count; the gate needs ${PROFILE_X_REWARD_MIN_FOLLOWERS}`,
        code,
      };
    case 'missing_x_username':
      return {
        eligible: false,
        label: 'Not eligible — no X account linked',
        detail: null,
        code,
      };
    case 'x_lookup_unavailable':
      return {
        eligible: false,
        label: 'Blocked — X could not be reached',
        detail:
          'Our side: no credentials or an X outage. Retried on the next check, and it does not count against the user',
        code,
      };
    case 'x_user_lookup_failed':
    case 'x_user_lookup_blocked':
      return {
        eligible: false,
        label: 'Not eligible — X account could not be resolved',
        detail:
          code === 'x_user_lookup_blocked'
            ? 'Failed repeatedly; the user must re-link X'
            : 'Single lookup failure',
        code,
      };
    case 'x_identity_already_rewarded':
      return {
        eligible: false,
        label: 'Not eligible — X account already claimed',
        detail: 'Another wallet is already earning with this X identity',
        code,
      };
    case 'x_posts_fetch_failed':
      return {
        eligible: false,
        label: 'Blocked — posts could not be read',
        detail: 'Transient; retried on the next check',
        code,
      };
    case 'post_fetch_disabled':
    case 'missing_keywords':
    case 'invalid_address':
      return {
        eligible: false,
        label: 'Blocked — program misconfigured',
        detail: 'Not the user’s fault; a server setting is missing',
        code,
      };
    case 'payout_send_failed':
      return {
        eligible: true,
        label: 'Eligible — payout failed',
        detail: 'Earned, but the on-chain send did not go through',
        code,
      };
    case 'payout_confirmation_pending':
      return {
        eligible: true,
        label: 'Eligible — payout in flight',
        detail: 'Sent, awaiting confirmation',
        code,
      };
    default:
      // An unmapped code must not read as "fine". Say plainly that it is
      // unrecognised and show it, rather than inventing a meaning for it.
      return {
        eligible: false,
        label: 'Not eligible — unrecognised state',
        detail: 'No description for this code yet',
        code,
      };
  }
}

function buildInviteLink(code: string): string {
  if (!PROFILE_X_INVITE_LINK_BASE_URL) return code;
  const base = PROFILE_X_INVITE_LINK_BASE_URL.replace(/\/+$/, '');
  return `${base}?xInvite=${encodeURIComponent(code)}`;
}

export type BclXOnboardingTierPoint = {
  tier_index: number | null;
  count: number;
};

/**
 * Onboarding payouts write no ledger row and the aggregate row carries no
 * settled-at timestamp, so there is no honest daily series for them. The funnel
 * and summary carry the onboarding totals instead.
 */
export type BclXOnboardingDailyPoint = {
  date: string; // YYYY-MM-DD
  linked: number;
  per_post_paid: number;
};

export type BclXOnboardingSummary = {
  linked_x: number;
  scanned: number;
  follower_eligible: number;
  qualifying_post: number;
  onboarding_paid: number;
  per_post_earning: number;
  streak_bonus_paid: number;
  /** onboarding_paid / linked_x, 0..1. */
  conversion_rate: number;
  min_followers_required: number;
  total_paid_ae: number;
};

@Injectable()
export class BclAffiliationAnalyticsService {
  /**
   * Upper bound on rows the explorer renders in one page. Bounded because the
   * page draws every row and each wallet's invite subtree; disclosed alongside
   * the match count so a truncated view is never mistaken for the whole.
   */
  static readonly X_EXPLORER_ROW_CAP = 1000;

  constructor(
    @InjectRepository(Invitation)
    private readonly invitationRepo: Repository<Invitation>,
    @InjectRepository(Tx)
    private readonly txRepo: Repository<Tx>,
    @InjectRepository(ProfileXInvite)
    private readonly profileXInviteRepo: Repository<ProfileXInvite>,
    @InjectRepository(ProfileXPostingReward)
    private readonly postingRewardRepo: Repository<ProfileXPostingReward>,
    @InjectRepository(ProfileXPostRewardLedger)
    private readonly postRewardLedgerRepo: Repository<ProfileXPostRewardLedger>,
    @InjectRepository(ProfileXStreakBonusReward)
    private readonly streakBonusRepo: Repository<ProfileXStreakBonusReward>,
    @InjectRepository(ProfileXInviteMilestoneReward)
    private readonly inviteMilestoneRepo: Repository<ProfileXInviteMilestoneReward>,
  ) {}

  async getDashboardData(params: {
    start_date?: string;
    end_date?: string;
  }): Promise<{
    series: BclAffiliationDailyPoint[];
    summary: BclAffiliationSummary;
    xVerification: {
      series: BclXVerificationDailyPoint[];
      summary: BclXVerificationSummary;
    };
    queryMs: number;
  }> {
    const { startDate, endDate } = this.parseDateRange(params);

    const start = Date.now();
    const [
      registeredByDay,
      redeemedByDay,
      revokedByDay,
      amountByDay,
      xVerification,
      totals,
      uniques,
      amountTotals,
    ] = await Promise.all([
      this.getDailyRegisteredCounts(startDate, endDate),
      this.getDailyStatusCounts('claimed', startDate, endDate),
      this.getDailyStatusCounts('revoked', startDate, endDate),
      this.getDailyRegisteredAmount(startDate, endDate),
      this.getXVerificationData(params),
      this.getTotals(startDate, endDate),
      this.getUniques(startDate, endDate),
      this.getAmountTotals(startDate, endDate),
    ]);

    const series = this.fillDailySeries(startDate, endDate, {
      registered: registeredByDay,
      redeemed: redeemedByDay,
      revoked: revokedByDay,
      amount_ae_registered: amountByDay,
    });
    const total_outstanding =
      totals.total_registered - totals.total_redeemed - totals.total_revoked;

    const avg_amount_ae_per_registered =
      totals.total_registered > 0
        ? amountTotals.total_amount_ae_registered / totals.total_registered
        : 0;
    const avg_amount_ae_per_inviter =
      uniques.unique_inviters > 0
        ? amountTotals.total_amount_ae_registered / uniques.unique_inviters
        : 0;

    const redeemed_rate =
      totals.total_registered > 0
        ? totals.total_redeemed / totals.total_registered
        : 0;
    const revoked_rate =
      totals.total_registered > 0
        ? totals.total_revoked / totals.total_registered
        : 0;

    const queryMs = Date.now() - start;

    return {
      series,
      summary: {
        ...totals,
        total_outstanding,
        ...uniques,
        ...amountTotals,
        avg_amount_ae_per_registered,
        avg_amount_ae_per_inviter,
        redeemed_rate,
        revoked_rate,
      },
      xVerification: {
        series: xVerification.series,
        summary: xVerification.summary,
      },
      queryMs,
    };
  }

  async getXVerificationData(params: {
    start_date?: string;
    end_date?: string;
  }): Promise<{
    series: BclXVerificationDailyPoint[];
    summary: BclXVerificationSummary;
    queryMs: number;
  }> {
    const { startDate, endDate } = this.parseDateRange(params);
    const start = Date.now();

    const [xVerifiedByDay, totalVerifiedUsers] = await Promise.all([
      this.getDailyXVerifications(startDate, endDate),
      this.getTotalVerifiedUsers(startDate, endDate),
    ]);
    const series = this.buildXVerificationSeries(
      startDate,
      endDate,
      xVerifiedByDay,
    );

    return {
      series,
      summary: {
        total_verified_users: totalVerifiedUsers,
      },
      queryMs: Date.now() - start,
    };
  }

  async getXInviteUsageData(params: {
    start_date?: string;
    end_date?: string;
  }): Promise<{
    series: BclXInviteUsageDailyPoint[];
    summary: BclXInviteUsageSummary;
    queryMs: number;
  }> {
    const { startDate, endDate } = this.parseDateRange(params);
    const start = Date.now();

    const [createdByDay, invitedByDay, totalCreated, totalInvited] =
      await Promise.all([
        this.getDailyXInviteCreatedCounts(startDate, endDate),
        this.getDailyXInviteBoundCounts(startDate, endDate),
        this.getTotalXInviteCreated(startDate, endDate),
        this.getTotalXInviteBound(startDate, endDate),
      ]);

    const series = this.buildXInviteUsageSeries(startDate, endDate, {
      created_codes: createdByDay,
      invited_users: invitedByDay,
    });

    return {
      series,
      summary: {
        total_created_codes: totalCreated,
        total_invited_users: totalInvited,
        invite_bind_rate: totalCreated > 0 ? totalInvited / totalCreated : 0,
      },
      queryMs: Date.now() - start,
    };
  }

  /**
   * The X onboarding funnel for the cohort that linked X inside the window.
   *
   * Every stage is a strict subset of the one above it, so the drop between two
   * rows is exactly where that slice of the cohort is stuck, and `blockers`
   * names the reason in the reward pipeline's own words.
   *
   * Note the pipeline is on-demand: a user is only ever scanned after they come
   * back and request a check, so a large `linked_x -> scanned` drop means people
   * linked X and were never evaluated, not that they failed a requirement.
   */
  async getXOnboardingData(params: {
    start_date?: string;
    end_date?: string;
  }): Promise<{
    funnel: BclXOnboardingStage[];
    blockers: BclXOnboardingBlocker[];
    tiers: BclXOnboardingTierPoint[];
    series: BclXOnboardingDailyPoint[];
    summary: BclXOnboardingSummary;
    queryMs: number;
  }> {
    const { startDate, endDate } = this.parseDateRange(params);
    const start = Date.now();

    const [
      cohort,
      perPostEarning,
      streakPaid,
      blockers,
      tiers,
      paidAettos,
      linkedByDay,
      perPostPaidByDay,
    ] = await Promise.all([
      this.getOnboardingCohortCounts(startDate, endDate),
      this.getOnboardingPerPostEarners(startDate, endDate),
      this.getOnboardingStreakEarners(startDate, endDate),
      this.getOnboardingBlockers(startDate, endDate),
      this.getOnboardingTierDistribution(startDate, endDate),
      this.getOnboardingPaidAettos(startDate, endDate),
      this.getDailyXVerifications(startDate, endDate),
      this.getDailyPerPostPaidCounts(startDate, endDate),
    ]);

    const linked = cohort.linked_x;
    const rate = (count: number) => (linked > 0 ? count / linked : 0);
    const funnel: BclXOnboardingStage[] = [
      { key: 'linked_x', label: 'Linked X', count: linked },
      { key: 'scanned', label: 'Checked at least once', count: cohort.scanned },
      {
        key: 'follower_eligible',
        label: `Followers >= ${PROFILE_X_REWARD_MIN_FOLLOWERS}`,
        count: cohort.follower_eligible,
      },
      {
        key: 'qualifying_post',
        label: 'Has a qualifying post',
        count: cohort.qualifying_post,
      },
      {
        key: 'onboarding_paid',
        label: 'Onboarding reward paid',
        count: cohort.onboarding_paid,
      },
    ].map((stage) => ({ ...stage, rate: rate(stage.count) }));

    const series = this.buildXOnboardingSeries(startDate, endDate, {
      linked: linkedByDay,
      per_post_paid: perPostPaidByDay,
    });

    return {
      funnel,
      blockers,
      tiers,
      series,
      summary: {
        ...cohort,
        per_post_earning: perPostEarning,
        streak_bonus_paid: streakPaid,
        conversion_rate: rate(cohort.onboarding_paid),
        min_followers_required: PROFILE_X_REWARD_MIN_FOLLOWERS,
        total_paid_ae: paidAettos / 1e18,
      },
      queryMs: Date.now() - start,
    };
  }

  /** Cohort window: when the address linked X, falling back to row creation. */
  private static readonly ONBOARDING_COHORT_AT =
    'COALESCE(r.verified_at, r.created_at)';

  /**
   * Stage predicates, read as "reached at least this far".
   *
   * Each one ORs in the stage below it, so the counts are nested by
   * construction and a later stage can never exceed an earlier one. Plain
   * per-stage predicates would not be: the reward row's scan fields are reset
   * when a user re-links a different handle, so a paid row can legitimately
   * show `qualified_posts_count = 0`, and a follower count read after a drop
   * can fall under the minimum. Testing the current field alone would then
   * report a funnel that widens further down, which is exactly the signal this
   * chart exists to give.
   */
  private static readonly ONBOARDING_REACHED = {
    paid: `r.status = 'paid'`,
    post: `(r.status = 'paid' OR r.qualified_posts_count > 0)`,
    eligible: `(r.status = 'paid' OR r.qualified_posts_count > 0 OR r.follower_count >= :minFollowers)`,
    scanned: `(r.status = 'paid' OR r.qualified_posts_count > 0 OR r.follower_count >= :minFollowers OR r.last_x_api_scan_at IS NOT NULL)`,
  };

  private async getOnboardingCohortCounts(startDate: Date, endDate: Date) {
    const at = BclAffiliationAnalyticsService.ONBOARDING_COHORT_AT;
    const reached = BclAffiliationAnalyticsService.ONBOARDING_REACHED;
    const row = await this.postingRewardRepo
      .createQueryBuilder('r')
      .select('COUNT(*)::int', 'linked_x')
      .addSelect(`COUNT(*) FILTER (WHERE ${reached.scanned})::int`, 'scanned')
      .addSelect(
        `COUNT(*) FILTER (WHERE ${reached.eligible})::int`,
        'follower_eligible',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ${reached.post})::int`,
        'qualifying_post',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE ${reached.paid})::int`,
        'onboarding_paid',
      )
      .where(`${at} >= :startDate`, { startDate })
      .andWhere(`${at} < :endDate`, { endDate })
      .setParameter('minFollowers', PROFILE_X_REWARD_MIN_FOLLOWERS)
      .getRawOne<{
        linked_x: number;
        scanned: number;
        follower_eligible: number;
        qualifying_post: number;
        onboarding_paid: number;
      }>();

    return {
      linked_x: Number(row?.linked_x || 0),
      scanned: Number(row?.scanned || 0),
      follower_eligible: Number(row?.follower_eligible || 0),
      qualifying_post: Number(row?.qualifying_post || 0),
      onboarding_paid: Number(row?.onboarding_paid || 0),
    };
  }

  private async getOnboardingPerPostEarners(startDate: Date, endDate: Date) {
    const at = BclAffiliationAnalyticsService.ONBOARDING_COHORT_AT;
    const row = await this.postRewardLedgerRepo
      .createQueryBuilder('l')
      .select('COUNT(DISTINCT l.address)::int', 'count')
      .innerJoin(ProfileXPostingReward, 'r', 'r.address = l.address')
      .where(`l.status = 'paid'`)
      .andWhere(`${at} >= :startDate`, { startDate })
      .andWhere(`${at} < :endDate`, { endDate })
      .getRawOne<{ count: number }>();
    return Number(row?.count || 0);
  }

  private async getOnboardingStreakEarners(startDate: Date, endDate: Date) {
    const at = BclAffiliationAnalyticsService.ONBOARDING_COHORT_AT;
    const row = await this.streakBonusRepo
      .createQueryBuilder('s')
      .select('COUNT(DISTINCT s.address)::int', 'count')
      .innerJoin(ProfileXPostingReward, 'r', 'r.address = s.address')
      .where(`s.status = 'paid'`)
      .andWhere(`${at} >= :startDate`, { startDate })
      .andWhere(`${at} < :endDate`, { endDate })
      .getRawOne<{ count: number }>();
    return Number(row?.count || 0);
  }

  /**
   * Why each unpaid member of the cohort is stuck. A real `error` from the
   * pipeline wins; otherwise the row's shape says where it stopped.
   */
  private async getOnboardingBlockers(
    startDate: Date,
    endDate: Date,
  ): Promise<BclXOnboardingBlocker[]> {
    const at = BclAffiliationAnalyticsService.ONBOARDING_COHORT_AT;
    // Shared with the reward pipeline and the verification-attempt history:
    // one definition of "this code is a notice, not a failure".
    const informational = X_INFORMATIONAL_ERROR_CODES.map(
      (code) => `'${code}'`,
    ).join(', ');
    const reason = `CASE
        WHEN r.error IS NOT NULL AND r.error <> ''
          AND r.error NOT IN (${informational}) THEN r.error
        WHEN r.last_x_api_scan_at IS NULL THEN 'never_checked'
        WHEN r.qualified_posts_count = 0 THEN 'no_qualifying_post'
        ELSE 'awaiting_payout'
      END`;
    const rows = await this.postingRewardRepo
      .createQueryBuilder('r')
      .select(reason, 'reason')
      .addSelect('COUNT(*)::int', 'count')
      .where(`r.status <> 'paid'`)
      .andWhere(`${at} >= :startDate`, { startDate })
      .andWhere(`${at} < :endDate`, { endDate })
      .groupBy('reason')
      .orderBy('count', 'DESC')
      .limit(20)
      .getRawMany<{ reason: string; count: number }>();

    return rows.map((r) => ({
      reason: r.reason || 'unknown',
      count: Number(r.count || 0),
    }));
  }

  private async getOnboardingTierDistribution(
    startDate: Date,
    endDate: Date,
  ): Promise<BclXOnboardingTierPoint[]> {
    const at = BclAffiliationAnalyticsService.ONBOARDING_COHORT_AT;
    const rows = await this.postingRewardRepo
      .createQueryBuilder('r')
      .select('r.follower_tier_index', 'tier_index')
      .addSelect('COUNT(*)::int', 'count')
      .where('r.follower_tier_index IS NOT NULL')
      .andWhere(`${at} >= :startDate`, { startDate })
      .andWhere(`${at} < :endDate`, { endDate })
      .groupBy('r.follower_tier_index')
      .orderBy('r.follower_tier_index', 'ASC')
      .getRawMany<{ tier_index: number | null; count: number }>();

    return rows.map((r) => ({
      tier_index: r.tier_index === null ? null : Number(r.tier_index),
      count: Number(r.count || 0),
    }));
  }

  /** Settled AE across per-post and streak payouts for the cohort, in aettos. */
  private async getOnboardingPaidAettos(
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    const at = BclAffiliationAnalyticsService.ONBOARDING_COHORT_AT;
    const sum = `COALESCE(SUM(NULLIF(%alias%.amount_aettos, '')::numeric), 0)::float`;
    const [perPost, streak] = await Promise.all([
      this.postRewardLedgerRepo
        .createQueryBuilder('l')
        .select(sum.replace('%alias%', 'l'), 'total')
        .innerJoin(ProfileXPostingReward, 'r', 'r.address = l.address')
        .where(`l.status = 'paid'`)
        .andWhere(`${at} >= :startDate`, { startDate })
        .andWhere(`${at} < :endDate`, { endDate })
        .getRawOne<{ total: number }>(),
      this.streakBonusRepo
        .createQueryBuilder('s')
        .select(sum.replace('%alias%', 's'), 'total')
        .innerJoin(ProfileXPostingReward, 'r', 'r.address = s.address')
        .where(`s.status = 'paid'`)
        .andWhere(`${at} >= :startDate`, { startDate })
        .andWhere(`${at} < :endDate`, { endDate })
        .getRawOne<{ total: number }>(),
    ]);

    return Number(perPost?.total || 0) + Number(streak?.total || 0);
  }

  /** Per-post rewards settled per day, keyed on when the row was ledgered. */
  private async getDailyPerPostPaidCounts(
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, number>> {
    const rows = await this.postRewardLedgerRepo
      .createQueryBuilder('l')
      .select(`to_char(date_trunc('day', l.created_at), 'YYYY-MM-DD')`, 'date')
      .addSelect('COUNT(*)::int', 'count')
      .where(`l.status = 'paid'`)
      .andWhere('l.created_at >= :startDate', { startDate })
      .andWhere('l.created_at < :endDate', { endDate })
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; count: number }>();

    const out: Record<string, number> = {};
    for (const r of rows) out[r.date] = Number(r.count || 0);
    return out;
  }

  private buildXOnboardingSeries(
    startDate: Date,
    endDate: Date,
    counts: {
      linked: Record<string, number>;
      per_post_paid: Record<string, number>;
    },
  ): BclXOnboardingDailyPoint[] {
    const start = moment(startDate).startOf('day');
    const end = moment(endDate).startOf('day');
    const out: BclXOnboardingDailyPoint[] = [];

    const cursor = start.clone();
    while (cursor.isBefore(end)) {
      const d = cursor.format('YYYY-MM-DD');
      out.push({
        date: d,
        linked: counts.linked[d] ?? 0,
        per_post_paid: counts.per_post_paid[d] ?? 0,
      });
      cursor.add(1, 'day');
    }
    return out;
  }

  async getTopInviters(params: {
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<{ items: BclAffiliationTopInviter[]; queryMs: number }> {
    const { startDate, endDate } = this.parseDateRange(params);
    const limit = this.sanitizeLimit(params.limit, 10);

    const start = Date.now();
    const rows = await this.invitationRepo
      .createQueryBuilder('r')
      .select('r.sender_address', 'inviter')
      .addSelect('COUNT(*)::int', 'registered_count')
      .addSelect(
        `COALESCE(SUM(NULLIF(r.amount, '')::numeric), 0)::float`,
        'total_amount_ae',
      )
      .where('r.created_at >= :startDate', { startDate })
      .andWhere('r.created_at < :endDate', { endDate })
      .andWhere('r.sender_address IS NOT NULL')
      .groupBy('r.sender_address')
      .orderBy('registered_count', 'DESC')
      .addOrderBy('total_amount_ae', 'DESC')
      .limit(limit)
      .getRawMany<
        Pick<
          BclAffiliationTopInviter,
          'inviter' | 'registered_count' | 'total_amount_ae'
        >
      >();

    const inviters = rows.map((r) => r.inviter).filter(Boolean);

    const [redeemedCounts, revokedCounts] = await Promise.all([
      inviters.length
        ? this.invitationRepo
            .createQueryBuilder('x')
            .select('x.sender_address', 'inviter')
            .addSelect('COUNT(*)::int', 'redeemed_count')
            .where('x.status = :status', { status: 'claimed' })
            .andWhere('x.status_updated_at >= :startDate', { startDate })
            .andWhere('x.status_updated_at < :endDate', { endDate })
            .andWhere('x.sender_address IN (:...inviters)', { inviters })
            .groupBy('x.sender_address')
            .getRawMany<{ inviter: string; redeemed_count: number }>()
        : Promise.resolve([]),
      inviters.length
        ? this.invitationRepo
            .createQueryBuilder('x')
            .select('x.sender_address', 'inviter')
            .addSelect('COUNT(*)::int', 'revoked_count')
            .where('x.status = :status', { status: 'revoked' })
            .andWhere('x.status_updated_at >= :startDate', { startDate })
            .andWhere('x.status_updated_at < :endDate', { endDate })
            .andWhere('x.sender_address IN (:...inviters)', { inviters })
            .groupBy('x.sender_address')
            .getRawMany<{ inviter: string; revoked_count: number }>()
        : Promise.resolve([]),
    ]);

    const redeemedByInviter = new Map(
      redeemedCounts.map((r) => [r.inviter, Number(r.redeemed_count || 0)]),
    );
    const revokedByInviter = new Map(
      revokedCounts.map((r) => [r.inviter, Number(r.revoked_count || 0)]),
    );

    const queryMs = Date.now() - start;
    return {
      items: rows.map((r) => ({
        ...r,
        redeemed_count: redeemedByInviter.get(r.inviter) ?? 0,
        revoked_count: revokedByInviter.get(r.inviter) ?? 0,
        pending_count:
          Number(r.registered_count || 0) -
          (redeemedByInviter.get(r.inviter) ?? 0) -
          (revokedByInviter.get(r.inviter) ?? 0),
      })),
      queryMs,
    };
  }

  private async getDailyRegisteredCounts(
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, number>> {
    const rows = await this.invitationRepo
      .createQueryBuilder('v')
      .select(`to_char(date_trunc('day', v.created_at), 'YYYY-MM-DD')`, 'date')
      .addSelect('COUNT(*)::int', 'count')
      .where('v.created_at >= :startDate', { startDate })
      .andWhere('v.created_at < :endDate', { endDate })
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; count: number }>();

    const out: Record<string, number> = {};
    for (const r of rows) out[r.date] = Number(r.count || 0);
    return out;
  }

  private async getDailyStatusCounts(
    status: 'claimed' | 'revoked',
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, number>> {
    const rows = await this.invitationRepo
      .createQueryBuilder('v')
      .select(
        `to_char(date_trunc('day', v.status_updated_at), 'YYYY-MM-DD')`,
        'date',
      )
      .addSelect('COUNT(*)::int', 'count')
      .where('v.status = :status', { status })
      .andWhere('v.status_updated_at >= :startDate', { startDate })
      .andWhere('v.status_updated_at < :endDate', { endDate })
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; count: number }>();

    const out: Record<string, number> = {};
    for (const r of rows) out[r.date] = Number(r.count || 0);
    return out;
  }

  private async getTotals(startDate: Date, endDate: Date) {
    const [registered, redeemed, revoked] = await Promise.all([
      this.invitationRepo
        .createQueryBuilder('r')
        .select('COUNT(*)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
        .getRawOne<{ count: number }>(),
      this.invitationRepo
        .createQueryBuilder('r')
        .select('COUNT(*)::int', 'count')
        .where('r.status = :status', { status: 'claimed' })
        .andWhere('r.status_updated_at >= :startDate', { startDate })
        .andWhere('r.status_updated_at < :endDate', { endDate })
        .getRawOne<{ count: number }>(),
      this.invitationRepo
        .createQueryBuilder('r')
        .select('COUNT(*)::int', 'count')
        .where('r.status = :status', { status: 'revoked' })
        .andWhere('r.status_updated_at >= :startDate', { startDate })
        .andWhere('r.status_updated_at < :endDate', { endDate })
        .getRawOne<{ count: number }>(),
    ]);

    return {
      total_registered: Number(registered?.count || 0),
      total_redeemed: Number(redeemed?.count || 0),
      total_revoked: Number(revoked?.count || 0),
    };
  }

  private async getUniques(startDate: Date, endDate: Date) {
    const [inviters, invitees, redeemers] = await Promise.all([
      this.invitationRepo
        .createQueryBuilder('r')
        .select('COUNT(DISTINCT r.sender_address)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
        .andWhere('r.sender_address IS NOT NULL')
        .getRawOne<{ count: number }>(),
      this.invitationRepo
        .createQueryBuilder('r')
        .select('COUNT(DISTINCT r.invitee_address)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
        .andWhere('r.invitee_address IS NOT NULL')
        .getRawOne<{ count: number }>(),
      this.invitationRepo
        .createQueryBuilder('r')
        .select('COUNT(DISTINCT r.invitee_address)::int', 'count')
        .where('r.status = :status', { status: 'claimed' })
        .andWhere('r.status_updated_at >= :startDate', { startDate })
        .andWhere('r.status_updated_at < :endDate', { endDate })
        .andWhere('r.invitee_address IS NOT NULL')
        .getRawOne<{ count: number }>(),
    ]);

    return {
      unique_inviters: Number(inviters?.count || 0),
      unique_invitees: Number(invitees?.count || 0),
      unique_redeemers: Number(redeemers?.count || 0),
    };
  }

  private fillDailySeries(
    startDate: Date,
    endDate: Date,
    counts: {
      registered: Record<string, number>;
      redeemed: Record<string, number>;
      revoked: Record<string, number>;
      amount_ae_registered: Record<string, number>;
    },
  ): BclAffiliationDailyPoint[] {
    const start = moment(startDate).startOf('day');
    const end = moment(endDate).startOf('day');
    const out: BclAffiliationDailyPoint[] = [];

    // endDate is exclusive in queries; series should include up to (endDate - 1 day)
    const cursor = start.clone();
    while (cursor.isBefore(end)) {
      const d = cursor.format('YYYY-MM-DD');
      out.push({
        date: d,
        registered: counts.registered[d] ?? 0,
        redeemed: counts.redeemed[d] ?? 0,
        revoked: counts.revoked[d] ?? 0,
        amount_ae_registered: counts.amount_ae_registered[d] ?? 0,
      });
      cursor.add(1, 'day');
    }
    return out;
  }

  private async getDailyRegisteredAmount(startDate: Date, endDate: Date) {
    const rows = await this.invitationRepo
      .createQueryBuilder('r')
      .select(`to_char(date_trunc('day', r.created_at), 'YYYY-MM-DD')`, 'date')
      .addSelect(
        `COALESCE(SUM(NULLIF(r.amount, '')::numeric), 0)::float`,
        'amount',
      )
      .where('r.created_at >= :startDate', { startDate })
      .andWhere('r.created_at < :endDate', { endDate })
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; amount: number }>();

    const out: Record<string, number> = {};
    for (const r of rows) out[r.date] = Number(r.amount || 0);
    return out;
  }

  private async getAmountTotals(startDate: Date, endDate: Date) {
    const row = await this.invitationRepo
      .createQueryBuilder('r')
      .select(
        `COALESCE(SUM(NULLIF(r.amount, '')::numeric), 0)::float`,
        'amount',
      )
      .where('r.created_at >= :startDate', { startDate })
      .andWhere('r.created_at < :endDate', { endDate })
      .getRawOne<{ amount: number }>();

    return {
      total_amount_ae_registered: Number(row?.amount || 0),
    };
  }

  /**
   * Daily count of newly X-verified addresses.
   *
   * Reads `profile_x_posting_rewards`, NOT the raw `link` transactions. The
   * previous query re-derived verifications from `t.raw->'arguments'` and so
   * counted only ONE of the four ways the pipeline actually records a link
   * (see `address-links-plugin-sync.service.ts`):
   *
   *   - `link(addr, provider, …)`          addr at arg 0, provider at arg 1
   *   - `link_principal(principal, signer, provider, …)`
   *                                        signer at arg 1, provider at arg 2
   *   - the contract-LOGS fallback, used whenever `raw.arguments` is absent —
   *     which has no `arguments` to read at all
   *
   * It matched `function = 'link'` with provider fixed at arg 1, so every
   * `link_principal` was dropped (wrong function, and its provider sits one
   * index further along), and every log-recovered link was invisible. That is
   * why this dashboard reported 0 while the onboarding funnel — which reads
   * this same table — reported real linked accounts.
   *
   * `handleLinkEvent` stamps `verified_at` from the transaction's `micro_time`
   * on every one of those paths, so this table is both authoritative and
   * correctly dated. The plugin also looks its arguments up BY NAME before
   * falling back to position, which positional SQL could never match.
   */
  private async getDailyXVerifications(
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, number>> {
    const rows = await this.postingRewardRepo
      .createQueryBuilder('r')
      .select(`to_char(date_trunc('day', r.verified_at), 'YYYY-MM-DD')`, 'date')
      .addSelect('COUNT(DISTINCT r.address)::int', 'count')
      .where('r.verified_at IS NOT NULL')
      .andWhere('r.x_username IS NOT NULL')
      .andWhere('r.verified_at >= :startDate', { startDate })
      .andWhere('r.verified_at < :endDate', { endDate })
      .groupBy(`to_char(date_trunc('day', r.verified_at), 'YYYY-MM-DD')`)
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; count: number }>();

    const out: Record<string, number> = {};
    for (const r of rows) {
      if (!r.date) {
        continue;
      }
      out[r.date] = Number(r.count || 0);
    }
    return out;
  }

  /**
   * Distinct addresses verified in the window. Same source as the daily series
   * above, so the summary and the chart can no longer disagree — they did
   * before, because only one of them was ever going to match a row.
   */
  private async getTotalVerifiedUsers(startDate: Date, endDate: Date) {
    const row = await this.postingRewardRepo
      .createQueryBuilder('r')
      .select('COUNT(DISTINCT r.address)::int', 'count')
      .where('r.verified_at IS NOT NULL')
      .andWhere('r.x_username IS NOT NULL')
      .andWhere('r.verified_at >= :startDate', { startDate })
      .andWhere('r.verified_at < :endDate', { endDate })
      .getRawOne<{ count: number }>();
    return Number(row?.count || 0);
  }

  private buildXVerificationSeries(
    startDate: Date,
    endDate: Date,
    dailyVerifiedByDate: Record<string, number>,
  ): BclXVerificationDailyPoint[] {
    const start = moment(startDate).startOf('day');
    const end = moment(endDate).startOf('day');
    const out: BclXVerificationDailyPoint[] = [];
    let cumulative = 0;

    const cursor = start.clone();
    while (cursor.isBefore(end)) {
      const d = cursor.format('YYYY-MM-DD');
      const daily = dailyVerifiedByDate[d] ?? 0;
      cumulative += daily;
      out.push({
        date: d,
        daily_new_verified: daily,
        cumulative_verified: cumulative,
      });
      cursor.add(1, 'day');
    }

    return out;
  }

  private async getDailyXInviteCreatedCounts(startDate: Date, endDate: Date) {
    const rows = await this.profileXInviteRepo
      .createQueryBuilder('i')
      .select(`to_char(date_trunc('day', i.created_at), 'YYYY-MM-DD')`, 'date')
      .addSelect('COUNT(*)::int', 'count')
      .where('i.created_at >= :startDate', { startDate })
      .andWhere('i.created_at < :endDate', { endDate })
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; count: number }>();

    const out: Record<string, number> = {};
    for (const r of rows) out[r.date] = Number(r.count || 0);
    return out;
  }

  private async getDailyXInviteBoundCounts(startDate: Date, endDate: Date) {
    const rows = await this.profileXInviteRepo
      .createQueryBuilder('i')
      .select(`to_char(date_trunc('day', i.bound_at), 'YYYY-MM-DD')`, 'date')
      .addSelect('COUNT(*)::int', 'count')
      .where('i.status = :status', { status: 'bound' })
      .andWhere('i.bound_at IS NOT NULL')
      .andWhere('i.bound_at >= :startDate', { startDate })
      .andWhere('i.bound_at < :endDate', { endDate })
      .groupBy('date')
      .orderBy('date', 'ASC')
      .getRawMany<{ date: string; count: number }>();

    const out: Record<string, number> = {};
    for (const r of rows) out[r.date] = Number(r.count || 0);
    return out;
  }

  private async getTotalXInviteCreated(startDate: Date, endDate: Date) {
    const row = await this.profileXInviteRepo
      .createQueryBuilder('i')
      .select('COUNT(*)::int', 'count')
      .where('i.created_at >= :startDate', { startDate })
      .andWhere('i.created_at < :endDate', { endDate })
      .getRawOne<{ count: number }>();
    return Number(row?.count || 0);
  }

  private async getTotalXInviteBound(startDate: Date, endDate: Date) {
    const row = await this.profileXInviteRepo
      .createQueryBuilder('i')
      .select('COUNT(*)::int', 'count')
      .where('i.status = :status', { status: 'bound' })
      .andWhere('i.bound_at IS NOT NULL')
      .andWhere('i.bound_at >= :startDate', { startDate })
      .andWhere('i.bound_at < :endDate', { endDate })
      .getRawOne<{ count: number }>();
    return Number(row?.count || 0);
  }

  private buildXInviteUsageSeries(
    startDate: Date,
    endDate: Date,
    counts: {
      created_codes: Record<string, number>;
      invited_users: Record<string, number>;
    },
  ): BclXInviteUsageDailyPoint[] {
    const start = moment(startDate).startOf('day');
    const end = moment(endDate).startOf('day');
    const out: BclXInviteUsageDailyPoint[] = [];

    const cursor = start.clone();
    while (cursor.isBefore(end)) {
      const d = cursor.format('YYYY-MM-DD');
      out.push({
        date: d,
        created_codes: counts.created_codes[d] ?? 0,
        invited_users: counts.invited_users[d] ?? 0,
      });
      cursor.add(1, 'day');
    }

    return out;
  }

  /**
   * Resolve the picker's dates to the half-open range the queries expect.
   *
   * Every query here compares `< :endDate`, so `endDate` is an EXCLUSIVE bound.
   * The pickers send the last day the operator selected, which parses to that
   * day's midnight — so passing it through unchanged excluded the whole of the
   * selected day. Since the default end is today, that meant the first load of
   * every dashboard silently omitted today: verifications, payouts and funnel
   * stages that happened in the last few hours were simply missing, which is
   * the worst possible day to lose while watching a launch.
   *
   * `end_date` is therefore inclusive of the day it names, and the exclusive
   * bound is midnight the morning after.
   */
  private parseDateRange(params: { start_date?: string; end_date?: string }) {
    const startDate = moment(
      params.start_date ?? moment().subtract(14, 'days').format('YYYY-MM-DD'),
      'YYYY-MM-DD',
      true,
    );
    const endDate = moment(params.end_date, 'YYYY-MM-DD', true);

    return {
      startDate: startDate.isValid()
        ? startDate.toDate()
        : moment().subtract(14, 'days').toDate(),
      endDate: endDate.isValid()
        ? endDate.add(1, 'day').toDate()
        : moment().add(1, 'day').toDate(),
    };
  }

  private sanitizeLimit(limit: number | undefined, fallback: number) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(100, Math.floor(n));
  }

  /**
   * Per-wallet view of the X flow, plus each wallet's invite subtree.
   *
   * The aggregate dashboards answer "how many"; this answers "who", which is
   * the question actually asked when the flow looks broken. It deliberately
   * returns wallets that STARTED and never finished alongside the verified
   * ones — an empty verified list and twenty stalled wallets is a very
   * different situation from nobody having tried, and the counts alone cannot
   * tell those apart.
   *
   * The tree is built from `profile_x_invites` (`?xInvite=` links), which is
   * the only inviter → invitee edge the product records. The `?ref=` post
   * referral code is a different mechanism entirely and is reported per user
   * rather than as an edge — see `BclXExplorerUser`. An unbound invite link is
   * returned too, with a null address: that is a real, meaningful state —
   * someone has a link out and nobody has taken it — and the UI draws it as an
   * empty slot rather than hiding it.
   */
  async getXExplorerData(params: {
    start_date?: string;
    end_date?: string;
  }): Promise<{
    users: BclXExplorerUser[];
    pending: BclXExplorerUser[];
    series: BclXExplorerDailyPoint[];
    summary: {
      verified_users: number;
      pending_users: number;
      invite_links_created: number;
      invite_links_taken: number;
      eligible_users: number;
      /**
       * Linked X and never scanned once. Nothing scans on a schedule, so this
       * is the number of people waiting on a check that will not happen until
       * they come back and press the button themselves.
       */
      never_scanned_users: number;
      total_ae_paid: string;
      payouts_paid: number;
      payouts_failed: number;
      matching_users: number;
      row_cap: number;
      truncated: boolean;
    };
    min_followers: number;
    explorer_base_url: string;
    queryMs: number;
  }> {
    const { startDate, endDate } = this.parseDateRange(params);
    const start = Date.now();

    // The date picker used to be decorative here: the range was parsed, used
    // for the chart axis, and never applied to the rows — so every figure on
    // the page described "the latest 200 wallets" whatever range was chosen.
    // COALESCE because a wallet that has not verified yet still belongs to the
    // day it entered the program.
    const rowScope = this.postingRewardRepo
      .createQueryBuilder('r')
      .where('COALESCE(r.verified_at, r.created_at) < :endDate', { endDate });
    // Lower bound only when the caller actually picked one. The shared default
    // is fourteen days, which is right for a rate-of-change chart and wrong
    // here: this page answers "who is in the program", and the wallets that
    // matter most are the ones that verified months ago and were never paid.
    // Defaulting to a fortnight would have hidden exactly those.
    if (params.start_date) {
      rowScope.andWhere('COALESCE(r.verified_at, r.created_at) >= :startDate', {
        startDate,
      });
    }

    // Counted before the cap, so the page can say how much it is not showing.
    // A truncated total presented as a total is how an operator concludes the
    // program paid less than it did.
    const matchingUsers = await rowScope.clone().getCount();

    const rows = await rowScope
      .orderBy('r.verified_at', 'DESC', 'NULLS LAST')
      .addOrderBy('r.created_at', 'DESC')
      .limit(BclAffiliationAnalyticsService.X_EXPLORER_ROW_CAP)
      .getMany();

    const addresses = rows.map((r) => r.address);

    // One query for every edge, then grouped in memory. A per-user query here
    // would be N+1 over a list the dashboard always renders whole.
    const invites = addresses.length
      ? await this.profileXInviteRepo
          .createQueryBuilder('i')
          .where('i.inviter_address IN (:...addresses)', { addresses })
          .orderBy('i.created_at', 'ASC')
          .getMany()
      : [];

    // Resolve invitee handles so the tree can show who someone actually
    // brought in, not just an address.
    const inviteeAddresses = Array.from(
      new Set(
        invites
          .map((i) => i.invitee_address)
          .filter((a): a is string => !!a && !addresses.includes(a)),
      ),
    );
    const inviteeRows = inviteeAddresses.length
      ? await this.postingRewardRepo
          .createQueryBuilder('r')
          .where('r.address IN (:...inviteeAddresses)', { inviteeAddresses })
          .getMany()
      : [];
    const byAddress = new Map(
      [...rows, ...inviteeRows].map((r) => [r.address, r]),
    );

    const invitesByInviter = new Map<string, typeof invites>();
    for (const invite of invites) {
      const list = invitesByInviter.get(invite.inviter_address) || [];
      list.push(invite);
      invitesByInviter.set(invite.inviter_address, list);
    }

    const iso = (d: Date | null | undefined) =>
      d instanceof Date ? d.toISOString() : null;

    // Every table that can hold an on-chain payout, one bulk query each, so
    // "did this wallet actually get paid" is answered from the ledgers rather
    // than inferred from a status column. Three separate programs pay out here
    // (onboarding, per-post, the streak bonus) plus invite milestones, and a
    // page that showed only one of them would be quietly wrong about the rest.
    const [perPostRows, streakRows, milestoneRows] = addresses.length
      ? await Promise.all([
          this.postRewardLedgerRepo
            .createQueryBuilder('l')
            .where('l.address IN (:...addresses)', { addresses })
            .orderBy('l.created_at', 'DESC')
            .getMany(),
          this.streakBonusRepo
            .createQueryBuilder('s')
            .where('s.address IN (:...addresses)', { addresses })
            .orderBy('s.created_at', 'DESC')
            .getMany(),
          this.inviteMilestoneRepo
            .createQueryBuilder('m')
            .where('m.inviter_address IN (:...addresses)', { addresses })
            .orderBy('m.created_at', 'DESC')
            .getMany(),
        ])
      : [[], [], []];

    const payoutsByAddress = new Map<string, BclXExplorerPayout[]>();
    const addPayout = (address: string, payout: BclXExplorerPayout) => {
      const list = payoutsByAddress.get(address) || [];
      list.push(payout);
      payoutsByAddress.set(address, list);
    };
    // The onboarding payout is NOT in the ledger, which is easy to assume and
    // wrong: `profile_x_post_reward_ledger` only ever receives
    // `reward_kind: 'per_post'` (its sole writer), while the onboarding send
    // writes `tx_hash` and `status` straight onto the profile_x_posting_rewards
    // row. Reading only the ledger dropped every onboarding payout from the
    // list, the explorer links and the totals. Caught in review on #210.
    for (const r of rows) {
      const inFlight = !!r.tx_hash && !isRealTxHash(r.tx_hash);

      // Detection keys on the DURABLE signals only. `error` is transient —
      // every scan overwrites it — so an earlier version that looked for
      // `payout_send_failed` lost a failed send the moment the next check ran:
      // that path writes `tx_hash: null` and `status: 'failed'`, leaving
      // nothing to find once the code was gone, and a wallet that earned but
      // was never paid then looked like it had never been tried. On
      // profile_x_posting_rewards `status: 'failed'` is written by exactly one
      // place, the onboarding payout failure path, so it means this and
      // nothing else.
      const attempted =
        r.status === 'paid' || r.status === 'failed' || !!r.tx_hash;
      if (!attempted) continue;

      const status = payoutStatus(r);

      // Only a payout error belongs on a payout row. This column is shared
      // with the eligibility codes later scans write, and surfacing
      // `below_min_followers` under a settled payout reads as "the send
      // failed" — which would be a lie about money that did arrive.
      const payoutError =
        r.error === 'payout_send_failed' ||
        r.error === 'payout_confirmation_pending'
          ? r.error
          : null;
      addPayout(r.address, {
        kind: 'onboarding',
        label: 'Onboarding reward',
        // This row records no amount, unlike every other reward table, so this
        // is the CURRENTLY configured value rather than what was actually sent
        // — said plainly in `detail` rather than passed off as a recorded fact.
        amount_ae: PROFILE_X_ONBOARDING_REWARD_AMOUNT_AE,
        status,
        tx_hash: isRealTxHash(r.tx_hash) ? r.tx_hash : null,
        explorer_url: explorerTxUrl(r.tx_hash),
        created_at: iso(r.verified_at) ?? iso(r.created_at),
        detail: inFlight
          ? 'send in progress; amount from current config'
          : isRealTxHash(r.tx_hash) && r.status !== 'paid'
            ? 'broadcast, awaiting confirmation; amount from current config'
            : 'amount from current config, not recorded on the row',
        error: payoutError,
      });
    }

    for (const l of perPostRows) {
      addPayout(l.address, {
        kind: 'per_post',
        label: 'Per-post reward',
        amount_ae: aettosToAe(l.amount_aettos),
        status: payoutStatus(l),
        tx_hash: isRealTxHash(l.tx_hash) ? l.tx_hash : null,
        explorer_url: explorerTxUrl(l.tx_hash),
        created_at: iso(l.created_at),
        detail: l.tweet_utc_day ? `post on ${l.tweet_utc_day}` : null,
        error: l.error ?? null,
      });
    }
    for (const s of streakRows) {
      addPayout(s.address, {
        kind: 'streak_bonus',
        label: 'Streak bonus',
        amount_ae: aettosToAe(s.amount_aettos),
        status: payoutStatus(s),
        tx_hash: isRealTxHash(s.tx_hash) ? s.tx_hash : null,
        explorer_url: explorerTxUrl(s.tx_hash),
        created_at: iso(s.created_at),
        detail: `${s.streak_length}-day streak to ${s.streak_completed_day}`,
        error: s.error ?? null,
      });
    }
    for (const m of milestoneRows) {
      addPayout(m.inviter_address, {
        kind: 'invite_milestone',
        label: 'Invite milestone',
        // This table records no amount, like the onboarding row. Reporting
        // null dropped settled milestones out of `total_ae_paid` while still
        // counting them in `payouts_paid`, so the "AE actually paid" figure
        // understated what had left the wallet. The configured value is the
        // best available answer, and `detail` says so rather than passing it
        // off as a recorded fact.
        amount_ae: PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE || null,
        status: payoutStatus(m),
        tx_hash: isRealTxHash(m.tx_hash) ? m.tx_hash : null,
        explorer_url: explorerTxUrl(m.tx_hash),
        created_at: iso(m.created_at),
        detail: `${m.threshold} invites; amount from current config, not recorded on the row`,
        error: m.error ?? null,
      });
    }

    const toUser = (r: (typeof rows)[number]): BclXExplorerUser => {
      const mine = invitesByInviter.get(r.address) || [];
      const payouts = payoutsByAddress.get(r.address) || [];
      // Only settled payouts count toward the total. Summing pending or failed
      // rows would report money that never left the wallet.
      const totalPaid = payouts
        .filter((p) => p.status === 'paid' && p.amount_ae)
        .reduce((sum, p) => sum.plus(p.amount_ae as string), new BigNumber(0));
      return {
        address: r.address,
        x_username: r.x_username ?? null,
        verified_at: iso(r.verified_at),
        post_referral_code: r.referral_code ?? null,
        post_referral_link: r.referral_code
          ? buildPostReferralLink(r.referral_code)
          : null,
        follower_count: r.follower_count ?? null,
        follower_tier_index: r.follower_tier_index ?? null,
        qualified_posts_count: r.qualified_posts_count ?? 0,
        current_streak_days: r.current_streak_days ?? 0,
        status: r.status,
        error: r.error ?? null,
        last_x_api_scan_at: iso(r.last_x_api_scan_at),
        created_at: iso(r.created_at),
        invite_links_created: mine.length,
        invite_links_taken: mine.filter((i) => !!i.invitee_address).length,
        invitees: mine.map((i) => {
          const invitee = i.invitee_address
            ? byAddress.get(i.invitee_address)
            : undefined;
          return {
            address: i.invitee_address ?? null,
            x_username: invitee?.x_username ?? null,
            verified_at: iso(invitee?.verified_at),
            bound_at: iso(i.bound_at),
            status: i.status,
            invite_code: i.code,
            invite_link: buildInviteLink(i.code),
          };
        }),
        eligibility: describeEligibility(r),
        payouts,
        total_ae_paid: totalPaid.toFixed(),
        explorer_account_url: explorerAccountUrl(r.address),
      };
    };

    const all = rows.map(toUser);
    const users = all.filter((u) => !!u.verified_at);
    const pending = all.filter((u) => !u.verified_at);

    // Two lines on one chart: verifications, and invite links created.
    // Bucketed in memory because both sides are already loaded and the row
    // count here is bounded by the limit above.
    const buckets = new Map<string, { verified: number; links: number }>();
    const bump = (day: string, key: 'verified' | 'links') => {
      const b = buckets.get(day) || { verified: 0, links: 0 };
      b[key] += 1;
      buckets.set(day, b);
    };
    for (const r of rows) {
      if (r.verified_at)
        bump(moment(r.verified_at).format('YYYY-MM-DD'), 'verified');
    }
    for (const i of invites) {
      if (i.created_at)
        bump(moment(i.created_at).format('YYYY-MM-DD'), 'links');
    }

    const series: BclXExplorerDailyPoint[] = [];
    const cursor = moment(startDate).startOf('day');
    const end = moment(endDate).startOf('day');
    while (cursor.isBefore(end)) {
      const day = cursor.format('YYYY-MM-DD');
      const b = buckets.get(day);
      series.push({
        date: day,
        verified: b?.verified ?? 0,
        invite_links: b?.links ?? 0,
      });
      cursor.add(1, 'day');
    }

    const allPayouts = [...users, ...pending].flatMap((u) => u.payouts);

    return {
      users,
      pending,
      series,
      summary: {
        verified_users: users.length,
        pending_users: pending.length,
        invite_links_created: invites.length,
        invite_links_taken: invites.filter((i) => !!i.invitee_address).length,
        eligible_users: all.filter((u) => u.eligibility.eligible).length,
        never_scanned_users: all.filter(
          (u) => !u.last_x_api_scan_at && u.status !== 'paid',
        ).length,
        total_ae_paid: allPayouts
          .filter((p) => p.status === 'paid' && p.amount_ae)
          .reduce((sum, p) => sum.plus(p.amount_ae as string), new BigNumber(0))
          .toFixed(),
        payouts_paid: allPayouts.filter((p) => p.status === 'paid').length,
        payouts_failed: allPayouts.filter((p) => p.status === 'failed').length,
        // Every figure above is computed from the rows on this page. When the
        // range holds more wallets than the cap, they are a sample and the page
        // has to say so — an operator reading a truncated `total_ae_paid` as
        // the total concludes the program paid less than it did.
        matching_users: matchingUsers,
        row_cap: BclAffiliationAnalyticsService.X_EXPLORER_ROW_CAP,
        truncated:
          matchingUsers > BclAffiliationAnalyticsService.X_EXPLORER_ROW_CAP,
      },
      min_followers: PROFILE_X_REWARD_MIN_FOLLOWERS,
      explorer_base_url: (ACTIVE_NETWORK?.explorerUrl || '').replace(
        /\/+$/,
        '',
      ),
      queryMs: Date.now() - start,
    };
  }
}
