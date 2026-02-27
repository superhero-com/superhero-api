import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({
  name: 'profile_x_invite_credits',
})
@Unique(['inviter_address', 'invitee_address'])
@Unique(['invitee_address'])
export class ProfileXInviteCredit {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  inviter_address: string;

  @Index()
  @Column()
  invitee_address: string;

  @Index()
  @Column()
  invite_code: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  verified_at: Date;
}
