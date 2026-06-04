import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One row per COMPLETED posting streak (every N consecutive posting days earns
 * the bonus again). The `(x_user_id, streak_completed_day)` unique constraint
 * is the idempotency primitive: a streak completion is recorded (insert-or-
 * ignore) and paid at most once, across concurrent scans, retries, restarts
 * and re-links of the same X identity to a fresh address (anti-sybil). After a
 * completion the streak counter resets, so the next completion lands on a
 * strictly later day.
 */
@Entity({
  name: 'profile_x_streak_bonus_rewards',
})
@Unique('ux_profile_x_streak_bonus_completion', [
  'x_user_id',
  'streak_completed_day',
])
export class ProfileXStreakBonusReward {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  address: string;

  @Index()
  @Column()
  x_user_id: string;

  @Column({
    type: 'int',
    default: 10,
  })
  streak_length: number;

  /** UTC day (YYYY-MM-DD) the Nth consecutive posting day was reached. */
  @Column({
    type: 'date',
  })
  streak_completed_day: string;

  /** Bonus amount in aettos, frozen at the time the completion was recorded. */
  @Column({
    nullable: true,
  })
  amount_aettos: string | null;

  @Index()
  @Column({
    nullable: true,
  })
  tx_hash: string | null;

  @Column({
    enum: ['pending', 'paid', 'failed', 'skipped'],
    default: 'pending',
  })
  status: 'pending' | 'paid' | 'failed' | 'skipped';

  @Column({
    type: 'text',
    nullable: true,
  })
  error: string | null;

  @Column({
    type: 'int',
    default: 0,
  })
  retry_count: number;

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  next_retry_at: Date | null;

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
