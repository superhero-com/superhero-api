import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn
} from 'typeorm';

@Entity({
  name: 'invitations',
})
export class Invitation {
  @PrimaryGeneratedColumn()
  id: string;

  // tx hash
  @Column()
  tx_hash: string;

  // block height
  @Column()
  block_height: number;

  // amount
  @Column({
    default: '0',
  })
  amount: string;

  @Index()
  @Column()
  sender_address: string;

  @Index()
  @Column({
    nullable: true,
  })
  invitee_address: string;

  @Index()
  @Column({
    unique: true,
  })
  receiver_address: string; // The temporary address for the invitee

  @Column({
    enum: ['pending', 'claimed', 'revoked'],
    default: 'pending',
  })
  status: string;

  // claim tx hash
  @Column({
    nullable: true,
  })
  claim_tx_hash: string;

  // revoke tx hash
  @Column({
    nullable: true,
  })
  revoke_tx_hash: string;

  @Column({
    type: 'timestamp',
    nullable: true,
  })
  status_updated_at: Date;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}
