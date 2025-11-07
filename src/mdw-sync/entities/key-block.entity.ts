import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';

@Entity({
  name: 'key_blocks',
})
@Index(['height'])
@Index(['hash'])
@Index(['prev_hash'])
@Index(['prev_key_hash'])
@ObjectType()
export class KeyBlock {
  @PrimaryColumn()
  @Field()
  hash: string;

  @Column({ unique: true })
  @Field(() => Int)
  height: number;

  @Column()
  @Field()
  prev_hash: string;

  @Column()
  @Field()
  prev_key_hash: string;

  @Column()
  @Field()
  state_hash: string;

  @Column()
  @Field()
  beneficiary: string;

  @Column()
  @Field()
  miner: string;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  time: string;

  @Column({ default: 0 })
  @Field(() => Int)
  transactions_count: number;

  @Column({ default: 0 })
  @Field(() => Int)
  micro_blocks_count: number;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  beneficiary_reward: string;

  @Column({ type: 'text' })
  @Field()
  flags: string;

  @Column({ type: 'text' })
  @Field()
  info: string;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  nonce: string;

  @Column({ type: 'jsonb' })
  @Field(() => [Int])
  pow: number[];

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  target: string;

  @Column({ type: 'int' })
  @Field(() => Int)
  version: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  created_at: Date;
}
