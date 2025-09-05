import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Pair } from './pair.entity';

@Entity({
  name: 'pair_transactions',
})
export class PairTransaction {
  @PrimaryColumn()
  tx_hash: string;

  @ManyToOne(() => Pair, (pair) => pair.address, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'pair_address' })
  pair: Pair;

  @Column()
  tx_type: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}
