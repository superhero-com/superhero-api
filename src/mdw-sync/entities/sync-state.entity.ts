import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';

@Entity({
  name: 'sync_state',
})
@ObjectType()
export class SyncState {
  @PrimaryColumn({ default: 'global' })
  @Field()
  id: string;

  @Column()
  @Field(() => Int)
  last_synced_height: number;

  @Column()
  @Field()
  last_synced_hash: string;

  @Column()
  @Field(() => Int)
  tip_height: number;

  @Column({ default: false })
  @Field({ defaultValue: false })
  is_bulk_mode: boolean;

  @Column({ nullable: true })
  @Field(() => Int, { nullable: true })
  backward_synced_height: number;

  @Column({ nullable: true })
  @Field(() => Int, { nullable: true })
  live_synced_height: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  updated_at: Date;
}
