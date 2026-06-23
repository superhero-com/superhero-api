import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'profile_x_posting_rewards',
})
@Index('ux_profile_x_posting_rewards_x_user_id', ['x_user_id'], {
  unique: true,
  where: 'x_user_id IS NOT NULL',
})
@Index('ux_profile_x_posting_rewards_referral_code', ['referral_code'], {
  unique: true,
  where: 'referral_code IS NOT NULL',
})
export class ProfileXPostingReward {
  @PrimaryColumn()
  address: string;

  @Index()
  @Column({
    nullable: true,
  })
  x_username: string | null;

  @Index()
  @Column({
    nullable: true,
  })
  x_user_id: string | null;

  /**
   * The X identity (x_user_id) this address became BOUND to the first time it
   * accrued a qualifying post. Unlike `x_user_id` — which resetStaleXIdentityState
   * clears on a handle change so the new handle scans fresh — this survives a
   * re-link, so a later scan that resolves a DIFFERENT identity is rejected: a
   * paid/earning address cannot farm per-post/streak rewards across multiple X
   * handles (onboarding is already once-per-address). A genuine handle RENAME
   * keeps the same x_user_id and passes.
   */
  @Column({
    nullable: true,
  })
  rewarded_x_user_id: string | null;

  @Column({
    type: 'int',
    default: 0,
  })
  qualified_posts_count: number;

  /** Per-user unique referral code; partial-unique while non-null (see class-level index). */
  @Column({
    nullable: true,
  })
  referral_code: string | null;

  /**
   * Anchor for the hard once-per-day X API cap. Set atomically (set-before-fetch)
   * so retries/restarts/concurrent requests cannot exceed one scan per window.
   */
  @Column({
    type: 'timestamp',
    nullable: true,
  })
  last_x_api_scan_at: Date | null;

  @Column({
    type: 'int',
    nullable: true,
  })
  follower_count: number | null;

  @Column({
    type: 'int',
    nullable: true,
  })
  follower_tier_index: number | null;

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  follower_snapshot_at: Date | null;

  /** UTC day (YYYY-MM-DD) of the most recent qualifying post, for streak math. */
  @Column({
    type: 'date',
    nullable: true,
  })
  last_qualifying_post_day: string | null;

  @Column({
    type: 'int',
    default: 0,
  })
  current_streak_days: number;

  /**
   * Consecutive failed X user lookups. Once it reaches the service's blocking
   * threshold, scans stop calling X for this row (so dead/sybil usernames can't
   * burn one paid lookup per day forever). Reset by a successful lookup or a
   * fresh on-chain X re-link.
   */
  @Column({
    type: 'int',
    default: 0,
  })
  x_lookup_failure_count: number;

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  verified_at: Date | null;

  @Column({
    nullable: true,
  })
  last_scanned_tweet_id: string | null;

  @Index()
  @Column({
    nullable: true,
  })
  tx_hash: string | null;

  @Column({
    enum: ['pending', 'paid', 'failed', 'blocked_x_identity_conflict'],
    default: 'pending',
  })
  status: 'pending' | 'paid' | 'failed' | 'blocked_x_identity_conflict';

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

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  last_attempt_at: Date | null;

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
