import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import moment from 'moment';
import { Invitation } from '../entities/invitation.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { ADDRESS_LINK_CONTRACT_ADDRESS } from '@/plugins/address-links/address-links.constants';
import { ProfileXInvite } from '@/profile/entities/profile-x-invite.entity';
import { ProfileXPostingReward } from '@/profile/entities/profile-x-posting-reward.entity';
import { ProfileXPostRewardLedger } from '@/profile/entities/profile-x-post-reward-ledger.entity';
import { ProfileXStreakBonusReward } from '@/profile/entities/profile-x-streak-bonus-reward.entity';
import {
  PROFILE_X_REWARD_MIN_FOLLOWERS,
  X_INFORMATIONAL_ERROR_CODES,
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
  /** `link(addr, …)` user address; not `caller_id` (sponsor broadcasts via onAccount). */
  private static readonly X_LINK_ADDRESS_SQL =
    "t.raw->'arguments'->0->>'value'";

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

  private async getDailyXVerifications(
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, number>> {
    const { startMicro, endMicro } = this.getMicroTimeRange(startDate, endDate);
    const linkedAddress = BclAffiliationAnalyticsService.X_LINK_ADDRESS_SQL;
    let qb = this.txRepo
      .createQueryBuilder('t')
      .select(linkedAddress, 'linked_address')
      .addSelect(
        // micro_time is milliseconds (see getMicroTimeRange); dividing by 1e6
        // would bucket every row into 1970 and match no day in the series.
        `MIN(to_char(date_trunc('day', to_timestamp((t.micro_time)::numeric / 1000.0)), 'YYYY-MM-DD'))`,
        'date',
      )
      .where('t.function = :fn', { fn: 'link' })
      .andWhere(`${linkedAddress} IS NOT NULL`)
      .andWhere("t.raw->'arguments'->1->>'value' = :provider", {
        provider: 'x',
      })
      .andWhere('t.micro_time::numeric >= :startMicro', { startMicro })
      .andWhere('t.micro_time::numeric < :endMicro', { endMicro });

    if (ADDRESS_LINK_CONTRACT_ADDRESS) {
      qb = qb.andWhere('t.contract_id = :contractId', {
        contractId: ADDRESS_LINK_CONTRACT_ADDRESS,
      });
    }

    const rows = await qb
      .groupBy(linkedAddress)
      .orderBy('date', 'ASC')
      .getRawMany<{ linked_address: string; date: string }>();

    const out: Record<string, number> = {};
    for (const r of rows) {
      if (!r.date) {
        continue;
      }
      out[r.date] = (out[r.date] || 0) + 1;
    }
    return out;
  }

  private async getTotalVerifiedUsers(startDate: Date, endDate: Date) {
    const { startMicro, endMicro } = this.getMicroTimeRange(startDate, endDate);
    const linkedAddress = BclAffiliationAnalyticsService.X_LINK_ADDRESS_SQL;
    let qb = this.txRepo
      .createQueryBuilder('t')
      .select(`COUNT(DISTINCT ${linkedAddress})::int`, 'count')
      .where('t.function = :fn', { fn: 'link' })
      .andWhere(`${linkedAddress} IS NOT NULL`)
      .andWhere("t.raw->'arguments'->1->>'value' = :provider", {
        provider: 'x',
      })
      .andWhere('t.micro_time::numeric >= :startMicro', { startMicro })
      .andWhere('t.micro_time::numeric < :endMicro', { endMicro });

    if (ADDRESS_LINK_CONTRACT_ADDRESS) {
      qb = qb.andWhere('t.contract_id = :contractId', {
        contractId: ADDRESS_LINK_CONTRACT_ADDRESS,
      });
    }

    const row = await qb.getRawOne<{ count: number }>();
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

  /**
   * Bounds for filtering `txs.micro_time`.
   *
   * Despite the name, `micro_time` is stored in MILLISECONDS: `block-sync.service`
   * and `live-indexer.service` write `tx.microTime` straight through, and build
   * `created_at` from the same value with `new Date(...)`, which only yields sane
   * timestamps for milliseconds. The middleware itself returns a 13-digit value.
   *
   * This used to scale the bounds to microseconds, which made every predicate
   * `micro_time >= <16-digit bound>` false against a 13-digit column, so the X
   * verification queries returned zero rows for every date range. Compare in
   * milliseconds, the same unit the column is written in.
   */
  private getMicroTimeRange(startDate: Date, endDate: Date) {
    return {
      startMicro: BigInt(startDate.getTime()).toString(),
      endMicro: BigInt(endDate.getTime()).toString(),
    };
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

  private parseDateRange(params: { start_date?: string; end_date?: string }) {
    const startDate = moment(
      params.start_date ?? moment().subtract(14, 'days').format('YYYY-MM-DD'),
      'YYYY-MM-DD',
      true,
    );
    const endDate = moment(
      params.end_date ?? moment().add(1, 'day').format('YYYY-MM-DD'),
      'YYYY-MM-DD',
      true,
    );

    return {
      startDate: startDate.isValid()
        ? startDate.toDate()
        : moment().subtract(14, 'days').toDate(),
      endDate: endDate.isValid()
        ? endDate.toDate()
        : moment().add(1, 'day').toDate(),
    };
  }

  private sanitizeLimit(limit: number | undefined, fallback: number) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(100, Math.floor(n));
  }
}
