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
    enum: ['pending', 'paid', 'failed'],
    default: 'pending',
  })
  status: 'pending' | 'paid' | 'failed';

  @Column({
    type: 'text',
    nullable: true,
  })
  error: string | null;

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
