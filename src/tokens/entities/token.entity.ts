import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Token {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    default: 'ae_mainnet', // || 'ae_uat'
  })
  network_id: string;

  @Column({
    nullable: true,
  })
  factory_address: string;

  @Column({
    unique: true,
  })
  address: string;

  @Column({
    default: 10000,
  })
  rank: number;

  @Column({
    default: 0,
  })
  price: number;

  @Column({
    default: 0,
  })
  sell_price: number;

  @Column({
    default: 0,
  })
  market_cap: number;

  @Column()
  name: string;
}
