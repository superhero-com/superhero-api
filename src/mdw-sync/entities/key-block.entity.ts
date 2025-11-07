import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';
import { Sortable } from '../decorators/sortable.decorator';
import { Searchable } from '../decorators/searchable.decorator';

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
  @Sortable()
  @Searchable()
  hash: string;

  @Column({ unique: true })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  @Searchable()
  height: number;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  prev_hash: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  prev_key_hash: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  state_hash: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  beneficiary: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  miner: string;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  @ApiProperty()
  @Sortable()
  time: string;

  @Column({ default: 0 })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  transactions_count: number;

  @Column({ default: 0 })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  micro_blocks_count: number;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  @Field()
  @ApiProperty()
  @Sortable()
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
  @Sortable()
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
  @Sortable()
  target: string;

  @Column({ type: 'int' })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  @Searchable()
  version: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  @ApiProperty()
  @Sortable()
  created_at: Date;
}
