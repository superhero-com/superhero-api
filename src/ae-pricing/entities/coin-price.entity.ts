import { IPriceDto } from '@/tokens/dto/price.dto';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({
  name: 'coin_prices',
})
export class CoinPrice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    type: 'json',
  })
  rates: IPriceDto; // { [currencyCode: string]: number }

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}
