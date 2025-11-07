import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { GraphQLJSONObject } from 'graphql-type-json';
import { ApiProperty } from '@nestjs/swagger';
import { MicroBlock } from './micro-block.entity';
import { Sortable } from '../decorators/sortable.decorator';
import { Searchable } from '../decorators/searchable.decorator';

@Entity({
  name: 'txs',
})
@Index(['hash'])
@Index(['block_height'])
@Index(['type'])
@Index(['contract_id'])
@Index(['function'])
@ObjectType()
export class Tx {
  @PrimaryColumn()
  @Field()
  @ApiProperty()
  @Sortable()
  hash: string;

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  block_hash: string;

  @ManyToOne(() => MicroBlock, (block) => block.hash, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'block_hash', referencedColumnName: 'hash' })
  @Field(() => MicroBlock, { nullable: true })
  block: MicroBlock;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  block_height: number;

  @Column({
    default: 1,
  })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  version: number;

  @Column({
    nullable: true,
  })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  encoded_tx: string;

  @Column({ type: 'bigint' })
  @Field()
  @ApiProperty()
  @Sortable()
  micro_index: string;

  @Column({ type: 'bigint' })
  @Field()
  @ApiProperty()
  @Sortable()
  micro_time: string;

  @Column({ type: 'jsonb' })
  @Field(() => [String])
  @ApiProperty({ type: [String] })
  signatures: string[];

  @Column()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  type: string;

  @Column({
    nullable: true,
  })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  payload: string;

  @Column({ nullable: true })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  @Sortable()
  @Searchable()
  contract_id?: string;

  @Column({ nullable: true })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  @Sortable()
  @Searchable()
  function?: string;

  @Column({ nullable: true })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  @Sortable()
  @Searchable()
  caller_id?: string;

  @Column({ nullable: true })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  @Sortable()
  @Searchable()
  sender_id?: string; 

  @Column({ nullable: true })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  @Sortable()
  @Searchable()
  recipient_id?: string;

  @Column({ type: 'jsonb' })
  @Field(() => GraphQLJSONObject, { nullable: true })
  @ApiProperty({ required: false })
  raw: any;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  @ApiProperty()
  @Sortable()
  created_at: Date;
}
