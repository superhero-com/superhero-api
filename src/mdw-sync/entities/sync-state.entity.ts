import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';

@Entity({
  name: 'sync_state',
})
@ObjectType()
export class SyncState {
  @PrimaryColumn({ default: 'global' })
  @Field()
  @ApiProperty()
  id: string;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  last_synced_height: number;

  @Column()
  @Field()
  @ApiProperty()
  last_synced_hash: string;

  @Column()
  @Field(() => Int)
  @ApiProperty()
  tip_height: number;

  @Column({ default: false })
  @Field({ defaultValue: false })
  @ApiProperty()
  is_bulk_mode: boolean;

  @Column({ nullable: true })
  @Field(() => Int, { nullable: true })
  @ApiProperty({ required: false })
  backward_synced_height: number;

  @Column({ nullable: true })
  @Field(() => Int, { nullable: true })
  @ApiProperty({ required: false })
  live_synced_height: number;

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
