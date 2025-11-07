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
  @ApiProperty()
  hash: string;

  @Column({ unique: true })
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

  @Column()
  @Field()
  @ApiProperty()
  beneficiary: string;

  @Column()
  @Field()
  @ApiProperty()
  miner: string;

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

  @Column({ default: 0 })
  @Field(() => Int)
  @ApiProperty()
  micro_blocks_count: number;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  @ApiProperty()
  beneficiary_reward: string;

  @Column({ type: 'text' })
  @Field()
  @ApiProperty()
  flags: string;

  @Column({ type: 'text' })
  @Field()
  @ApiProperty()
  info: string;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  @ApiProperty()
  nonce: string;

  @Column({ type: 'jsonb' })
  @Field(() => [Int])
  @ApiProperty({ type: [Number] })
  pow: number[];

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  @ApiProperty()
  target: string;

  @Column({ type: 'int' })
  @Field(() => Int)
  @ApiProperty()
  version: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  @ApiProperty()
  created_at: Date;
}
