import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
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
  @Column()
  amount: number;

  @Index()
  @Column()
  sender_address: string;

  @Index()
  @Column()
  receiver_address: string;

  @Column({
    enum: ['pending', 'claimed', 'revoked'],
    default: 'pending',
  })
  status: string;

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
