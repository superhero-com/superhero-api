import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';

@Entity({
  name: 'plugin_sync_state',
})
@Index(['plugin_name'])
@Index(['is_active'])
@ObjectType()
export class PluginSyncState {
  @PrimaryColumn()
  @Field()
  @ApiProperty()
  plugin_name: string;

  @Column({
    default: 1,
  })
  @Field(() => Int)
  @ApiProperty()
  version: number;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  last_synced_height: number;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  start_from_height: number;

  @Column({ default: true })
  @Field({ defaultValue: true })
  @ApiProperty()
  is_active: boolean;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  @ApiProperty()
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  @ApiProperty()
  updated_at: Date;
}
