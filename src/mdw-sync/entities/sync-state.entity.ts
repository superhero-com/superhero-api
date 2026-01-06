import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';
import { Sortable } from '@/api-core/decorators/sortable.decorator';
import { Searchable } from '@/api-core/decorators/searchable.decorator';

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

  /**
   * Indexer-owned "final" head height.
   * Only the IndexerService is allowed to advance this value.
   *
   * This prevents websocket live indexing from masking gaps by inserting only the latest keyblock
   * (e.g. storing height 1200 without having 1001-1199).
   */
  // IMPORTANT: select=false keeps the app backward-compatible with older DB schemas
  // where this column may not exist yet. The indexer explicitly selects it only after
  // detecting the column exists (post-migration/DB_SYNC).
  @Column({ nullable: true, select: false })
  @Field(() => Int, { nullable: true })
  @ApiProperty({ required: false })
  @Sortable()
  indexer_head_height: number;

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
