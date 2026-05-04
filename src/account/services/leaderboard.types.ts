/**
 * Hard ceiling on rows materialized per leaderboard window. The snapshot job
 * (`LeaderboardSnapshotService.refreshAllWindows`) only writes the top N
 * candidates per window, so any read-side query against
 * `account_leaderboard_snapshots` filtered by `window = $w` returns at most
 * this many rows. The leaderboard read service relies on this bound so its
 * inline `COUNT(*) OVER()` stays O(≤N) regardless of caller pagination.
 *
 * If this is ever raised beyond a few thousand, revisit the read path: switch
 * to cursor pagination or drop `totalItems` from the response, otherwise the
 * COUNT will start to dominate.
 */
export const LEADERBOARD_SNAPSHOT_MAX_CANDIDATES = 100;

export type LeaderboardWindow = '7d' | '30d' | 'all';
export type LeaderboardSortBy = 'pnl' | 'roi' | 'mdd' | 'aum';
export type LeaderboardSortDir = 'ASC' | 'DESC';

export interface LeaderboardTimeFilter {
  start: Date;
  end: Date;
}

export interface LeaderboardItemActivePeriod {
  buy_count: number;
  sell_count: number;
  volume_usd?: number;
}

export interface LeaderboardItem {
  address: string;
  chain_name?: string | null;
  // metrics are snapshot-scoped by default; when startDate + endDate are
  // supplied, they are computed over that selected time window.
  aum_usd: number;
  pnl_usd: number;
  roi_pct: number;
  mdd_pct: number;
  // activity follows the same scope as the metrics above.
  buy_count: number;
  sell_count: number;
  created_tokens_count: number;
  owned_trends_count: number;
  // chart
  portfolio_value_usd_sparkline: Array<[number, number]>;
  // Event-window traded volume, present only for selected-period leaderboards.
  volume_usd?: number;
  // Deprecated compatibility field from the first time-filter implementation.
  // Selected-period leaderboards now use top-level event-window metrics instead.
  active_period?: LeaderboardItemActivePeriod;
}

export interface GetLeadersParams {
  window?: LeaderboardWindow;
  sortBy?: LeaderboardSortBy;
  sortDir?: LeaderboardSortDir;
  page?: number;
  limit?: number;
  points?: number;
  minAumUsd?: number;
  startDate?: string;
  endDate?: string;
  tradingOnly?: boolean;
  maxCandidates?: number; // kept for API compatibility, ignored in snapshot mode
}
