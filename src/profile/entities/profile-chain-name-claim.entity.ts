import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ChainNameClaimStatus =
  | 'pending'
  | 'preclaimed'
  | 'claimed'
  | 'completed'
  | 'failed';

@Entity({
  name: 'profile_chain_name_claims',
})
export class ProfileChainNameClaim {
  @PrimaryColumn()
  address: string;

  @Index({ unique: true })
  @Column()
  name: string;

  @Column({
    enum: ['pending', 'preclaimed', 'claimed', 'completed', 'failed'],
    default: 'pending',
  })
  status: ChainNameClaimStatus;

  @Column({
    type: 'text',
    nullable: true,
  })
  salt: string | null;

  @Column({
    type: 'int',
    nullable: true,
  })
  preclaim_height: number | null;

  @Index()
  @Column({ nullable: true })
  preclaim_tx_hash: string | null;

  @Index()
  @Column({ nullable: true })
  claim_tx_hash: string | null;

  @Index()
  @Column({ nullable: true })
  update_tx_hash: string | null;

  @Index()
  @Column({ nullable: true })
  transfer_tx_hash: string | null;

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
