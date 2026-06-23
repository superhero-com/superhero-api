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
 * One row per qualifying tweet that earns (or is queued to earn) a reward.
 *
 * The `(x_user_id, tweet_id)` unique constraint is the load-bearing idempotency
 * primitive: an insert-or-ignore guarantees each tweet is rewarded at most once,
 * even across concurrent scans, retries and process restarts. Keying on the X
 * user id (not the AE address) also prevents re-paying the same tweets after a
 * user re-links the same X account to a fresh address (anti-sybil), mirroring
 * the `ux_profile_x_posting_rewards_x_user_id` constraint on the aggregate row.
 *
 * The `(x_user_id, tweet_utc_day)` unique constraint enforces the economic cap
 * of AT MOST ONE rewarded referral post per X identity per UTC day at the DB
 * level — bulk-tweeting the referral link cannot drain the reward wallet.
 */
@Entity({
  name: 'profile_x_post_reward_ledger',
})
@Unique('ux_profile_x_post_reward_ledger_identity', ['x_user_id', 'tweet_id'])
@Index('ux_profile_x_post_reward_ledger_day', ['x_user_id', 'tweet_utc_day'], {
  unique: true,
  where: '"tweet_utc_day" IS NOT NULL',
})
export class ProfileXPostRewardLedger {
  @PrimaryGeneratedColumn()
  id: string;

  @Index()
  @Column()
  address: string;

  @Index()
  @Column()
  x_user_id: string;

  @Index()
  @Column()
  tweet_id: string;

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  tweet_created_at: Date | null;

  /** UTC day (YYYY-MM-DD) of the tweet; anchors the one-reward-per-day cap. */
  @Column({
    type: 'date',
    nullable: true,
  })
  tweet_utc_day: string | null;

  @Column({
    enum: ['onboarding', 'per_post'],
    default: 'per_post',
  })
  reward_kind: 'onboarding' | 'per_post';

  /** Reward amount in aettos, frozen at the time the post was ledgered. */
  @Column({
    nullable: true,
  })
  amount_aettos: string | null;

  @Column({
    type: 'int',
    nullable: true,
  })
  follower_count_at_post: number | null;

  @Column({
    type: 'int',
    nullable: true,
  })
  tier_index_at_post: number | null;

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
