import { Token } from '@/tokens/entities/token.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PerformancePeriod {
  PAST_24H = 'past_24h',
  PAST_7D = 'past_7d',
  PAST_30D = 'past_30d',
  ALL_TIME = 'all_time',
}

@Entity('token_performance')
export class TokenPerformance {
  @PrimaryColumn()
  sale_address: string;

  @OneToOne(() => Token, (token) => token.performance, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'sale_address',
    referencedColumnName: 'sale_address',
  })
  token: Token;

  // Past 24h performance data
  @Column({
    type: 'json',
    nullable: true,
  })
  past_24h: any;

  // Past 7d performance data
  @Column({
    type: 'json',
    nullable: true,
  })
  past_7d: any;

  // Past 30d performance data
  @Column({
    type: 'json',
    nullable: true,
  })
  past_30d: any;

  // All time performance data
  @Column({
    type: 'json',
    nullable: true,
  })
  all_time: any;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}
