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
  @Sortable()
  @Searchable()
  hash: string;

  @Column()
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

  @Column({ type: 'text' })
  @Field()
  @ApiProperty()
  flags: string;

  @Column({ type: 'int' })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  @Searchable()
  version: number;

  @Column({ default: 0 })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  @Searchable()
  gas: number;

  @Column({ default: 0 })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  @Searchable()
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
  @Sortable()
  created_at: Date;
}
