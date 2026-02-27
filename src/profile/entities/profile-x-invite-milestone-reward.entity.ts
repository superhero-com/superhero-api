import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'profile_x_invite_milestone_rewards',
})
@Unique(['inviter_address', 'threshold'])
export class ProfileXInviteMilestoneReward {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  inviter_address: string;

  @Column({
    default: 10,
  })
  threshold: number;

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
