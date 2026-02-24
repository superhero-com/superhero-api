import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountLeaderboardSnapshot } from '../entities/account-leaderboard-snapshot.entity';

export type LeaderboardWindow = '7d' | '30d' | 'all';
export type LeaderboardSortBy = 'pnl' | 'roi' | 'mdd' | 'aum';
export type LeaderboardSortDir = 'ASC' | 'DESC';

export interface GetLeadersParams {
  window: LeaderboardWindow;
  sortBy: LeaderboardSortBy;
  sortDir?: LeaderboardSortDir;
  page?: number;
  limit?: number;
  points?: number;
  minAumUsd?: number;
  maxCandidates?: number; // kept for API compatibility, ignored in snapshot mode
}

export interface LeaderboardItem {
  address: string;
  chain_name?: string | null;
  // metrics
  aum_usd: number;
  pnl_usd: number;
  roi_pct: number;
  mdd_pct: number;
  // activity
  buy_count: number;
  sell_count: number;
  created_tokens_count: number;
  owned_trends_count: number;
  // chart
  portfolio_value_usd_sparkline: Array<[number, number]>;
}

@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(AccountLeaderboardSnapshot)
    private readonly snapshotRepository: Repository<AccountLeaderboardSnapshot>,
  ) {}

  async getLeaders(params: GetLeadersParams): Promise<{
    items: LeaderboardItem[];
    totalCandidates: number;
    page: number;
    limit: number;
  }> {
    const window = params.window ?? '7d';
    const sortBy = params.sortBy ?? 'pnl';
    const sortDir = params.sortDir ?? (sortBy === 'mdd' ? 'ASC' : 'DESC');
    const page = Math.max(1, params.page || 1);
    const limit = Math.max(1, Math.min(params.limit || 18, 50));
    const minAumUsd = params.minAumUsd ?? 1; // default: exclude ~0 AUM
    const qb = this.snapshotRepository
      .createQueryBuilder('snap')
      .where('snap.window = :window', { window })
      .andWhere('snap.aum_usd >= :minAumUsd', { minAumUsd });

    const sortColumn =
      sortBy === 'pnl'
        ? 'snap.pnl_usd'
        : sortBy === 'roi'
          ? 'snap.roi_pct'
          : sortBy === 'mdd'
            ? 'snap.mdd_pct'
            : 'snap.aum_usd';

    qb.orderBy(sortColumn, sortDir);

    const [rows, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const items: LeaderboardItem[] = rows.map((row) => ({
      address: row.address,
      chain_name: row.chain_name ?? null,
      aum_usd: row.aum_usd,
      pnl_usd: row.pnl_usd,
      roi_pct: row.roi_pct,
      mdd_pct: row.mdd_pct,
      buy_count: row.buy_count,
      sell_count: row.sell_count,
      created_tokens_count: row.created_tokens_count,
      owned_trends_count: row.owned_trends_count,
      portfolio_value_usd_sparkline: row.portfolio_value_usd_sparkline || [],
    }));

    return {
      items,
      totalCandidates: total,
      page,
      limit,
    };
  }
}
