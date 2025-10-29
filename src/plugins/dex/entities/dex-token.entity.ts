import { IPriceDto } from '@/tokens/dto/price.dto';
import {
  Column,
  CreateDateColumn,
  Entity,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { DexTokenSummary } from './dex-token-summary.entity';

@Entity({
  name: 'dex_tokens',
})
export class DexToken {
  @PrimaryColumn()
  address: string;

  @Column()
  name: string;

  @Column()
  symbol: string;

  @Column({
    default: 18,
  })
  decimals: number;

  @Column({
    default: 0,
  })
  pairs_count: number;

  @Column({
    type: 'json',
    nullable: true,
  })
  price: IPriceDto;

  @Column({
    default: false,
  })
  is_ae: boolean;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;

  @OneToOne(() => DexTokenSummary, (summary) => summary.token)
  summary: DexTokenSummary;
}
