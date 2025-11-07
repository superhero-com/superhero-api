import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';

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
  @ApiProperty()
  hash: string;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  height: number;

  @Column()
  @Field()
  @ApiProperty()
  prev_hash: string;

  @Column()
  @Field()
  @ApiProperty()
  prev_key_hash: string;

  @Column()
  @Field()
  @ApiProperty()
  state_hash: string;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  @ApiProperty()
  time: string;

  @Column({ default: 0 })
  @Field(() => Int)
  @ApiProperty()
  transactions_count: number;

  @Column({ type: 'text' })
  @Field()
  @ApiProperty()
  flags: string;

  @Column({ type: 'int' })
  @Field(() => Int)
  @ApiProperty()
  version: number;

  @Column({ default: 0 })
  @Field(() => Int)
  @ApiProperty()
  gas: number;

  @Column({ default: 0 })
  @Field(() => Int)
  @ApiProperty()
  micro_block_index: number;

  @Column()
  @Field()
  @ApiProperty()
  pof_hash: string;

  @Column()
  @Field()
  @ApiProperty()
  signature: string;

  @Column()
  @Field()
  @ApiProperty()
  txs_hash: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  @ApiProperty()
  created_at: Date;
}
