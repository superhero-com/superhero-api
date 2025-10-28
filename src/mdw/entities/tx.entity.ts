import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity({
  name: 'txs',
})
export class Tx {
  @Index()
  @PrimaryColumn()
  hash: string;

  @Column()
  block_height: number;

  @Column({
    default: false,
  })
  verified: boolean;

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}
