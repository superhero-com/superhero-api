import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import moment from 'moment';
import { BclInvitationRegistered } from '../entities/bcl-invitation-registered.view';
import { BclInvitationRedeemed } from '../entities/bcl-invitation-redeemed.view';
import { BclInvitationRevoked } from '../entities/bcl-invitation-revoked.view';

export type BclAffiliationDailyPoint = {
  date: string; // YYYY-MM-DD
  registered: number;
  redeemed: number;
  revoked: number;
};

export type BclAffiliationSummary = {
  total_registered: number;
  total_redeemed: number;
  total_revoked: number;
  total_outstanding: number;
  unique_inviters: number;
  unique_invitees: number;
  unique_redeemers: number;
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

@Injectable()
export class BclAffiliationAnalyticsService {
  constructor(
    @InjectRepository(BclInvitationRegistered)
    private readonly registeredRepo: Repository<BclInvitationRegistered>,
    @InjectRepository(BclInvitationRedeemed)
    private readonly redeemedRepo: Repository<BclInvitationRedeemed>,
    @InjectRepository(BclInvitationRevoked)
    private readonly revokedRepo: Repository<BclInvitationRevoked>,
  ) {}

  async getDashboardData(params: {
    start_date?: string;
    end_date?: string;
  }): Promise<{
    series: BclAffiliationDailyPoint[];
    summary: BclAffiliationSummary;
    queryMs: number;
  }> {
    const { startDate, endDate } = this.parseDateRange(params);

    const start = Date.now();
    const [registeredByDay, redeemedByDay, revokedByDay] = await Promise.all([
      this.getDailyCounts(this.registeredRepo, startDate, endDate),
      this.getDailyCounts(this.redeemedRepo, startDate, endDate),
      this.getDailyCounts(this.revokedRepo, startDate, endDate),
    ]);

    const [totals, uniques] = await Promise.all([
      this.getTotals(startDate, endDate),
      this.getUniques(startDate, endDate),
    ]);

    const series = this.fillDailySeries(startDate, endDate, {
      registered: registeredByDay,
      redeemed: redeemedByDay,
      revoked: revokedByDay,
    });

    const total_outstanding =
      totals.total_registered - totals.total_redeemed - totals.total_revoked;

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
        redeemed_rate,
        revoked_rate,
      },
      queryMs,
    };
  }

  async getTopInviters(params: {
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<{ items: BclAffiliationTopInviter[]; queryMs: number }> {
    const { startDate, endDate } = this.parseDateRange(params);
    const limit = this.sanitizeLimit(params.limit, 10);

    const start = Date.now();
    const rows = await this.registeredRepo
      .createQueryBuilder('r')
      .select('r.inviter', 'inviter')
      .addSelect('COUNT(*)::int', 'registered_count')
      .addSelect(
        `COALESCE(SUM(NULLIF(r.amount, '')::numeric), 0)::float`,
        'total_amount_ae',
      )
      .where('r.created_at >= :startDate', { startDate })
      .andWhere('r.created_at < :endDate', { endDate })
      .andWhere('r.inviter IS NOT NULL')
      .groupBy('r.inviter')
      .orderBy('registered_count', 'DESC')
      .addOrderBy('total_amount_ae', 'DESC')
      .limit(limit)
      .getRawMany<Pick<
        BclAffiliationTopInviter,
        'inviter' | 'registered_count' | 'total_amount_ae'
      >>();

    const inviters = rows.map((r) => r.inviter).filter(Boolean);

    const [redeemedCounts, revokedCounts] = await Promise.all([
      inviters.length
        ? this.redeemedRepo
            .createQueryBuilder('x')
            .select('x.inviter', 'inviter')
            .addSelect('COUNT(*)::int', 'redeemed_count')
            .where('x.created_at >= :startDate', { startDate })
            .andWhere('x.created_at < :endDate', { endDate })
            .andWhere('x.inviter IN (:...inviters)', { inviters })
            .groupBy('x.inviter')
            .getRawMany<{ inviter: string; redeemed_count: number }>()
        : Promise.resolve([]),
      inviters.length
        ? this.revokedRepo
            .createQueryBuilder('x')
            .select('x.inviter', 'inviter')
            .addSelect('COUNT(*)::int', 'revoked_count')
            .where('x.created_at >= :startDate', { startDate })
            .andWhere('x.created_at < :endDate', { endDate })
            .andWhere('x.inviter IN (:...inviters)', { inviters })
            .groupBy('x.inviter')
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

  private async getDailyCounts<T>(
    repo: Repository<T>,
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, number>> {
    const rows = await repo
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

  private async getTotals(startDate: Date, endDate: Date) {
    const [registered, redeemed, revoked] = await Promise.all([
      this.registeredRepo
        .createQueryBuilder('r')
        .select('COUNT(*)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
        .getRawOne<{ count: number }>(),
      this.redeemedRepo
        .createQueryBuilder('r')
        .select('COUNT(*)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
        .getRawOne<{ count: number }>(),
      this.revokedRepo
        .createQueryBuilder('r')
        .select('COUNT(*)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
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
      this.registeredRepo
        .createQueryBuilder('r')
        .select('COUNT(DISTINCT r.inviter)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
        .andWhere('r.inviter IS NOT NULL')
        .getRawOne<{ count: number }>(),
      this.registeredRepo
        .createQueryBuilder('r')
        .select('COUNT(DISTINCT r.invitee)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
        .andWhere('r.invitee IS NOT NULL')
        .getRawOne<{ count: number }>(),
      this.redeemedRepo
        .createQueryBuilder('r')
        .select('COUNT(DISTINCT r.redeemer)::int', 'count')
        .where('r.created_at >= :startDate', { startDate })
        .andWhere('r.created_at < :endDate', { endDate })
        .andWhere('r.redeemer IS NOT NULL')
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
      startDate: startDate.isValid() ? startDate.toDate() : moment().subtract(14, 'days').toDate(),
      endDate: endDate.isValid() ? endDate.toDate() : moment().add(1, 'day').toDate(),
    };
  }

  private sanitizeLimit(limit: number | undefined, fallback: number) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(100, Math.floor(n));
  }
}


