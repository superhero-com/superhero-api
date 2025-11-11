import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';

@Entity({
  name: 'governance_polls',
})
export class GovernancePoll {
  @PrimaryColumn()
  id: string;

  @Column()
  poll_id: string;

  @Column()
  tx_hash: string;

  @ManyToOne(() => Tx, (tx) => tx.hash, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tx_hash', referencedColumnName: 'hash' })
  tx: Tx;

  @Column()
  creator_address: string;

  @Column({ nullable: true })
  status: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}

