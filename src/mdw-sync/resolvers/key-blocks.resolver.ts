import { Resolver, Query, Args, Int } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { paginate } from 'nestjs-typeorm-paginate';

@Resolver(() => KeyBlock)
export class KeyBlocksResolver {
  constructor(
    @InjectRepository(KeyBlock)
    private readonly keyBlockRepository: Repository<KeyBlock>,
  ) {}

  @Query(() => [KeyBlock], { name: 'keyBlocks' })
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
    const query = this.keyBlockRepository.createQueryBuilder('key_block');

    if (orderBy) {
      query.orderBy(
        `key_block.${orderBy}`,
        orderDirection || 'DESC',
      );
    } else {
      query.orderBy('key_block.height', 'DESC');
    }

    const result = await paginate(query, { page, limit });
    return result.items;
  }

  @Query(() => KeyBlock, { name: 'keyBlock', nullable: true })
  async findOne(@Args('hash', { type: () => String }) hash: string) {
    return this.keyBlockRepository.findOne({
      where: { hash },
    });
  }
}

