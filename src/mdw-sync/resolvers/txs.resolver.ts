import { Resolver, Query, Args, Int, ResolveField, Parent } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '../entities/tx.entity';
import { MicroBlock } from '../entities/micro-block.entity';
import { paginate } from 'nestjs-typeorm-paginate';

@Resolver(() => Tx)
export class TxsResolver {
  constructor(
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
    @InjectRepository(MicroBlock)
    private readonly microBlockRepository: Repository<MicroBlock>,
  ) {}

  @Query(() => [Tx], { name: 'txs' })
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
    const query = this.txRepository.createQueryBuilder('tx');

    if (orderBy) {
      query.orderBy(`tx.${orderBy}`, orderDirection || 'DESC');
    } else {
      query.orderBy('tx.block_height', 'DESC');
    }

    const result = await paginate(query, { page, limit });
    return result.items;
  }

  @Query(() => Tx, { name: 'tx', nullable: true })
  async findOne(@Args('hash', { type: () => String }) hash: string) {
    return this.txRepository.findOne({
      where: { hash },
    });
  }

  @ResolveField(() => MicroBlock, { name: 'block', nullable: true })
  async resolveBlock(@Parent() tx: Tx): Promise<MicroBlock | null> {
    if (!tx.block_hash) {
      return null;
    }
    return this.microBlockRepository.findOne({
      where: { hash: tx.block_hash },
    });
  }
}

