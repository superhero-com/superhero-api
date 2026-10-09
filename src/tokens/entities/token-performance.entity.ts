import { Column, Entity, PrimaryColumn } from 'typeorm';

export interface TokenPerformancePeriod {
  current: any;
  current_date: Date;
  current_change: number | null;
  current_change_percent: number | null;
  current_change_direction: 'up' | 'down' | 'neutral' | null;
  high: any;
  high_date: Date;
  low: any;
  low_date: Date;
  last_updated: Date;
  volume: string | null;
}

export interface TokenPerformanceAllTime {
  current: any;
  current_date: Date;
  high: any;
  high_date: Date;
  low: any;
  low_date: Date;
}

// Filled by RefreshTokenPerformanceService. A table rather than a materialized
// view so a refresh rewrites only the tokens whose stats changed.
@Entity({ name: 'token_performance' })
export class TokenPerformance {
  @PrimaryColumn()
  sale_address: string;

  @Column({ type: 'json', nullable: true })
  past_24h: TokenPerformancePeriod | null;

  @Column({ type: 'json', nullable: true })
  past_7d: TokenPerformancePeriod | null;

  @Column({ type: 'json', nullable: true })
  past_30d: TokenPerformancePeriod | null;

  @Column({ type: 'json', nullable: true })
  all_time: TokenPerformanceAllTime | null;
}
