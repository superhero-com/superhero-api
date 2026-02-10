import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({
  name: 'profile_update_challenges',
})
export class ProfileUpdateChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  challenge: string;

  @Column()
  address: string;

  @Column()
  action: string;

  @Column()
  payload_hash: string;

  @Column({
    type: 'timestamp',
  })
  expires_at: Date;

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  consumed_at: Date | null;

  @Column({
    nullable: true,
  })
  request_ip: string | null;

  @Column({
    nullable: true,
  })
  user_agent: string | null;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}
