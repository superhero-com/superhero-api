import { Resolver, Query, Args, Int, ResolveField, Parent } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KeyBlock } from '../entities/key-block.entity';
import { Tx } from '../entities/tx.entity';
import { MicroBlock } from '../entities/micro-block.entity';
import { paginate } from 'nestjs-typeorm-paginate';
import { PaginatedResponse } from '../types/pagination.type';

const PaginatedKeyBlockResponse = PaginatedResponse(KeyBlock);

@Resolver(() => KeyBlock)
export class KeyBlocksResolver {
  constructor(
    @InjectRepository(KeyBlock)
    private readonly keyBlockRepository: Repository<KeyBlock>,
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
    @InjectRepository(MicroBlock)
    private readonly microBlockRepository: Repository<MicroBlock>,
  ) {}

  @Query(() => PaginatedKeyBlockResponse, { name: 'keyBlocks' })
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
    return {
      items: result.items,
      metaInfo: result.meta,
    };
  }

  @Query(() => KeyBlock, { name: 'keyBlock', nullable: true })
  async findOne(@Args('hash', { type: () => String }) hash: string) {
    return this.keyBlockRepository.findOne({
      where: { hash },
    });
  }

  @ResolveField(() => [Tx], { name: 'txs' })
  async resolveTxs(
    @Parent() keyBlock: KeyBlock,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 })
    limit: number = 100,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number = 0,
    @Args('type', { type: () => String, nullable: true })
    type?: string,
    @Args('function', { type: () => String, nullable: true })
    functionName?: string,
    @Args('sender_id', { type: () => String, nullable: true })
    sender_id?: string,
    @Args('orderBy', { type: () => String, nullable: true })
    orderBy?: string,
    @Args('orderDirection', { type: () => String, nullable: true })
    orderDirection?: 'ASC' | 'DESC',
  ): Promise<Tx[]> {
    const query = this.txRepository
      .createQueryBuilder('tx')
      .where('tx.block_height = :height', { height: keyBlock.height });

    if (type) {
      query.andWhere('tx.type = :type', { type });
    }

    if (functionName) {
      query.andWhere('tx.function = :function', { function: functionName });
    }

    if (sender_id) {
      query.andWhere('tx.sender_id = :sender_id', { sender_id });
    }

    if (orderBy) {
      query.orderBy(`tx.${orderBy}`, orderDirection || 'DESC');
    } else {
      query.orderBy('tx.block_height', 'DESC');
    }

    query.limit(limit).offset(offset);

    return query.getMany();
  }

  @ResolveField(() => [MicroBlock], { name: 'microBlocks' })
  async resolveMicroBlocks(
    @Parent() keyBlock: KeyBlock,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 100 })
    limit: number = 100,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number = 0,
    @Args('transactions_count', { type: () => Int, nullable: true })
    transactions_count?: number,
    @Args('gas', { type: () => Int, nullable: true })
    gas?: number,
    @Args('version', { type: () => Int, nullable: true })
    version?: number,
    @Args('micro_block_index', { type: () => Int, nullable: true })
    micro_block_index?: number,
    @Args('orderBy', { type: () => String, nullable: true })
    orderBy?: string,
    @Args('orderDirection', { type: () => String, nullable: true })
    orderDirection?: 'ASC' | 'DESC',
  ): Promise<MicroBlock[]> {
    const query = this.microBlockRepository
      .createQueryBuilder('micro_block')
      .where('micro_block.prev_key_hash = :hash', { hash: keyBlock.hash });

    if (transactions_count !== undefined) {
      query.andWhere('micro_block.transactions_count = :transactions_count', {
        transactions_count,
      });
    }

    if (gas !== undefined) {
      query.andWhere('micro_block.gas = :gas', { gas });
    }

    if (version !== undefined) {
      query.andWhere('micro_block.version = :version', { version });
    }

    if (micro_block_index !== undefined) {
      query.andWhere('micro_block.micro_block_index = :micro_block_index', {
        micro_block_index,
      });
    }

    if (orderBy) {
      query.orderBy(`micro_block.${orderBy}`, orderDirection || 'DESC');
    } else {
      query.orderBy('micro_block.micro_block_index', 'ASC');
    }

    query.limit(limit).offset(offset);

    return query.getMany();
  }
}

