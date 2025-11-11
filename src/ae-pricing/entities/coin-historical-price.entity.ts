import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({
  name: 'coin_historical_prices',
})
@Index('IDX_COIN_CURRENCY_TIMESTAMP', ['coin_id', 'currency', 'timestamp_ms'])
@Index('IDX_TIMESTAMP', ['timestamp_ms'])
export class CoinHistoricalPrice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    type: 'varchar',
    length: 50,
  })
  coin_id: string;

  @Column({
    type: 'varchar',
    length: 10,
  })
  currency: string;

  @Column({
    type: 'bigint',
  })
  timestamp_ms: number;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
  })
  price: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}
