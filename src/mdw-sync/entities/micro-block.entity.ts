import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';

@Entity({
  name: 'micro_blocks',
})
@Index(['height'])
@Index(['hash'])
@Index(['prev_hash'])
@Index(['prev_key_hash'])
@ObjectType()
export class MicroBlock {
  @PrimaryColumn()
  @Field()
  hash: string;

  @Column()
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

  @Column({ type: 'text' })
  @Field()
  flags: string;

  @Column({ type: 'int' })
  @Field(() => Int)
  version: number;

  @Column({ default: 0 })
  @Field(() => Int)
  gas: number;

  @Column({ default: 0 })
  @Field(() => Int)
  micro_block_index: number;

  @Column()
  @Field()
  pof_hash: string;

  @Column()
  @Field()
  signature: string;

  @Column()
  @Field()
  txs_hash: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  created_at: Date;
}
