import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';

@Entity({
  name: 'plugin_sync_state',
})
@Index(['plugin_name'])
@Index(['is_active'])
@ObjectType()
export class PluginSyncState {
  @PrimaryColumn()
  @Field()
  plugin_name: string;

  @Column({
    default: 1,
  })
  @Field(() => Int)
  version: number;

  @Column()
  @Field(() => Int)
  last_synced_height: number;

  @Column()
  @Field(() => Int)
  start_from_height: number;

  @Column({ default: true })
  @Field({ defaultValue: true })
  is_active: boolean;

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
