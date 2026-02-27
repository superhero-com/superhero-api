import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'profile_x_verification_rewards',
})
export class ProfileXVerificationReward {
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
  tx_hash: string | null;

  @Column({
    enum: [
      'pending',
      'paid',
      'failed',
      'ineligible_followers',
      'blocked_username_conflict',
    ],
    default: 'pending',
  })
  status:
    | 'pending'
    | 'paid'
    | 'failed'
    | 'ineligible_followers'
    | 'blocked_username_conflict';

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
