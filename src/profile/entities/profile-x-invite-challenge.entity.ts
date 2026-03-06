import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'profile_x_invite_challenges',
})
export class ProfileXInviteChallenge {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column()
  nonce: string;

  @Index()
  @Column()
  address: string;

  @Column({
    enum: ['create', 'bind'],
  })
  purpose: 'create' | 'bind';

  @Index()
  @Column({
    nullable: true,
  })
  invite_code: string | null;

  @Column({
    type: 'timestamp',
  })
  expires_at: Date;

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  consumed_at: Date | null;

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
