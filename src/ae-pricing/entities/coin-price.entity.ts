import { IPriceDto } from 'src/tokens/dto/price.dto';
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
  amount: IPriceDto; // Total spent/received amount

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}
