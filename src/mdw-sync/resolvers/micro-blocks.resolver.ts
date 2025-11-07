import { Resolver, Query, Args, Int } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MicroBlock } from '../entities/micro-block.entity';
import { paginate } from 'nestjs-typeorm-paginate';

@Resolver(() => MicroBlock)
export class MicroBlocksResolver {
  constructor(
    @InjectRepository(MicroBlock)
    private readonly microBlockRepository: Repository<MicroBlock>,
  ) {}

  @Query(() => [MicroBlock], { name: 'microBlocks' })
  async findAll(
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page: number = 1,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 })
    limit: number = 100,
    @Args('orderBy', { type: () => String, nullable: true })
    orderBy?: string,
    @Args('orderDirection', { type: () => String, nullable: true })
    orderDirection?: 'ASC' | 'DESC',
  ) {
    const query = this.microBlockRepository.createQueryBuilder('micro_block');

    if (orderBy) {
      query.orderBy(
        `micro_block.${orderBy}`,
        orderDirection || 'DESC',
      );
    } else {
      query.orderBy('micro_block.height', 'DESC');
    }

    const result = await paginate(query, { page, limit });
    return result.items;
  }

  @Query(() => MicroBlock, { name: 'microBlock', nullable: true })
  async findOne(@Args('hash', { type: () => String }) hash: string) {
    return this.microBlockRepository.findOne({
      where: { hash },
    });
  }
}

