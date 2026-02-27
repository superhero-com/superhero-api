import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({
  name: 'profile_x_invites',
})
@Unique(['code'])
@Unique(['invitee_address'])
export class ProfileXInvite {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  inviter_address: string;

  @Index()
  @Column({
    nullable: true,
  })
  invitee_address: string | null;

  @Column()
  code: string;

  @Column({
    enum: ['active', 'bound'],
    default: 'active',
  })
  status: 'active' | 'bound';

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  bound_at: Date | null;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}
