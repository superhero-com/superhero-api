import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { LeaderboardWindow } from '../services/leaderboard.service';

@Entity({ name: 'account_leaderboard_snapshots' })
@Index(['window', 'aum_usd'])
export class AccountLeaderboardSnapshot {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 10 })
  window: LeaderboardWindow; // '7d' | '30d' | 'all'

  @Column({ type: 'varchar', length: 64 })
  address: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  chain_name?: string | null;

  // metrics
  @Column({ type: 'double precision', default: 0 })
  aum_usd: number;

  @Column({ type: 'double precision', default: 0 })
  pnl_usd: number;

  @Column({ type: 'double precision', default: 0 })
  roi_pct: number;

  @Column({ type: 'double precision', default: 0 })
  mdd_pct: number;

  // activity
  @Column({ type: 'int', default: 0 })
  buy_count: number;

  @Column({ type: 'int', default: 0 })
  sell_count: number;

  @Column({ type: 'int', default: 0 })
  created_tokens_count: number;

  @Column({ type: 'int', default: 0 })
  owned_trends_count: number;

  // sparkline: [timestamp_ms, value_usd][]
  @Column({ type: 'jsonb', nullable: true })
  portfolio_value_usd_sparkline: Array<[number, number]> | null;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}


