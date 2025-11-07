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
  name: 'plugin_failed_transaction',
})
@Index(['plugin_name'])
@Index(['version'])
@Index(['tx_hash'])
@Index(['plugin_name', 'version'])
@ObjectType()
export class PluginFailedTransaction {
  @PrimaryColumn()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  plugin_name: string;

  @PrimaryColumn()
  @Field()
  @ApiProperty()
  @Sortable()
  @Searchable()
  tx_hash: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  error_message: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  @Field({ nullable: true })
  @ApiProperty({ required: false })
  error_trace: string;

  @Column({
    default: 1,
  })
  @Field(() => Int)
  @ApiProperty()
  @Sortable()
  version: number;

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

