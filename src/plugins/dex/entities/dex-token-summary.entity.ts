import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DexToken } from './dex-token.entity';

@Entity({
  name: 'dex_token_summaries',
})
export class DexTokenSummary {
  @PrimaryColumn()
  token_address: string;

  @ManyToOne(() => DexToken, (token) => token.address, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'token_address' })
  token: DexToken;

  @Column({
    type: 'jsonb',
  })
  total_volume: any;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  change: any;

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
