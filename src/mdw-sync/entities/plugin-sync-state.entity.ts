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
import { Sortable } from '@/api-core/decorators/sortable.decorator';
import { Searchable } from '@/api-core/decorators/searchable.decorator';

@Entity({
  name: 'plugin_sync_state',
})
@Index(['plugin_name'])
@ObjectType()
export class PluginSyncState {
  @PrimaryColumn()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  plugin_name: string;

  @Column({
    default: 1,
  })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  version: number;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  last_synced_height: number;

  @Column({ nullable: true })
  @Field(() => Int, { nullable: true })
  @ApiProperty({ required: false })
  @Sortable()
  backward_synced_height: number;

  @Column({ nullable: true })
  @Field(() => Int, { nullable: true })
  @ApiProperty({ required: false })
  @Sortable()
  live_synced_height: number;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  start_from_height: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  @ApiProperty()
  @Sortable()
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Field()
  @ApiProperty()
  @Sortable()
  updated_at: Date;
}
