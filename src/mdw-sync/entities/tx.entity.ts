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
import { MicroBlock } from './micro-block.entity';

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
  hash: string;

  @Column()
  @Field()
  block_hash: string;

  @ManyToOne(() => MicroBlock, (block) => block.hash, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'block_hash', referencedColumnName: 'hash' })
  @Field(() => MicroBlock, { nullable: true })
  block: MicroBlock;

  @Column()
  @Field(() => Int)
  block_height: number;

  @Column({
    default: 1,
  })
  @Field(() => Int)
  version: number;

  @Column({
    nullable: true,
  })
  @Field({ nullable: true })
  encoded_tx: string;

  @Column({ type: 'bigint' })
  @Field()
  micro_index: string;

  @Column({ type: 'bigint' })
  @Field()
  micro_time: string;

  @Column({ type: 'jsonb' })
  @Field(() => [String])
  signatures: string[];

  @Column()
  @Field()
  type: string;

  @Column({
    nullable: true,
  })
  @Field({ nullable: true })
  payload: string;

  @Column({ nullable: true })
  @Field({ nullable: true })
  contract_id?: string;

  @Column({ nullable: true })
  @Field({ nullable: true })
  function?: string;

  @Column({ nullable: true })
  @Field({ nullable: true })
  caller_id?: string;

  @Column({ nullable: true })
  @Field({ nullable: true })
  sender_id?: string; 

  @Column({ nullable: true })
  @Field({ nullable: true })
  recipient_id?: string;

  @Column({ type: 'jsonb' })
  @Field(() => GraphQLJSONObject, { nullable: true })
  raw: any;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  created_at: Date;
}
