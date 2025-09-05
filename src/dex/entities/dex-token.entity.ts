import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

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
    default: '0',
  })
  price_ae: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}
