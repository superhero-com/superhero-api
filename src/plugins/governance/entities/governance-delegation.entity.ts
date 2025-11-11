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
  name: 'governance_delegations',
})
export class GovernanceDelegation {
  @PrimaryColumn()
  id: string;

  @Column()
  tx_hash: string;

  @ManyToOne(() => Tx, (tx) => tx.hash, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tx_hash', referencedColumnName: 'hash' })
  tx: Tx;

  @Column()
  delegator_address: string;

  @Column()
  delegate_address: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}

