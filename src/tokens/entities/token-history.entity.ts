import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

@Entity()
export class TokenHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  sale_address: string;

  @Column({
    default: 0,
  })
  price: string;

  @Column({
    default: 0,
  })
  sell_price: string;

  @Column({
    default: 0,
  })
  market_cap: string;

  @Column({
    default: 0n,
  })
  total_supply: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}
