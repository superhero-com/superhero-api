import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Pair } from './pair.entity';

@Entity({
  name: 'pair_summaries',
})
export class PairSummary {
  @PrimaryColumn()
  pair_address: string;

  @ManyToOne(() => Pair, (pair) => pair.address, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'pair_address' })
  pair: Pair;

  @Column({
    type: 'varchar',
    length: 100,
  })
  volume_token: string;

  @Column({
    type: 'varchar',
    length: 1,
  })
  token_position: string;

  @Column({
    type: 'jsonb',
  })
  total_volume: any;

  @Column({
    type: 'jsonb',
  })
  change_24h: any;

  @Column({
    type: 'jsonb',
  })
  change_7d: any;

  @Column({
    type: 'jsonb',
  })
  change_30d: any;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public updated_at: Date;
}
