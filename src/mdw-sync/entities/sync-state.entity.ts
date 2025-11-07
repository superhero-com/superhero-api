import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';
import { Sortable } from '../decorators/sortable.decorator';
import { Searchable } from '../decorators/searchable.decorator';

@Entity({
  name: 'sync_state',
})
@ObjectType()
export class SyncState {
  @PrimaryColumn({ default: 'global' })
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  id: string;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  last_synced_height: number;

  @Column()
  @Field()
  @ApiProperty()
  last_synced_hash: string;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  tip_height: number;

  @Column({ default: false })
  @Field({ defaultValue: false })
  @ApiProperty()
  @Sortable()
  is_bulk_mode: boolean;

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
