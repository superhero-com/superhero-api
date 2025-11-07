import { Resolver, Query, Args, Int, ResolveField, Parent } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MicroBlock } from '../entities/micro-block.entity';
import { KeyBlock } from '../entities/key-block.entity';
import { Tx } from '../entities/tx.entity';
import { paginate } from 'nestjs-typeorm-paginate';
import { PaginatedResponse } from '@/api-core/types/pagination.type';

const PaginatedMicroBlockResponse = PaginatedResponse(MicroBlock);

@Resolver(() => MicroBlock)
export class MicroBlocksResolver {
  constructor(
    @InjectRepository(MicroBlock)
    private readonly microBlockRepository: Repository<MicroBlock>,
    @InjectRepository(KeyBlock)
    private readonly keyBlockRepository: Repository<KeyBlock>,
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
  ) {}

  @Query(() => PaginatedMicroBlockResponse, { name: 'microBlocks' })
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
    return {
      items: result.items,
      metaInfo: result.meta,
    };
  }

  @Query(() => MicroBlock, { name: 'microBlock', nullable: true })
  async findOne(@Args('hash', { type: () => String }) hash: string) {
    return this.microBlockRepository.findOne({
      where: { hash },
    });
  }

  @ResolveField(() => KeyBlock, { name: 'keyBlock', nullable: true })
  async resolveKeyBlock(@Parent() microBlock: MicroBlock): Promise<KeyBlock | null> {
    if (!microBlock.prev_key_hash) {
      return null;
    }
    return this.keyBlockRepository.findOne({
      where: { hash: microBlock.prev_key_hash },
    });
  }

  @ResolveField(() => [Tx], { name: 'txs' })
  async resolveTxs(
    @Parent() microBlock: MicroBlock,
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
    @Args('recipient_id', { type: () => String, nullable: true })
    recipient_id?: string,
    @Args('contract_id', { type: () => String, nullable: true })
    contract_id?: string,
    @Args('caller_id', { type: () => String, nullable: true })
    caller_id?: string,
    @Args('orderBy', { type: () => String, nullable: true })
    orderBy?: string,
    @Args('orderDirection', { type: () => String, nullable: true })
    orderDirection?: 'ASC' | 'DESC',
  ): Promise<Tx[]> {
    const query = this.txRepository
      .createQueryBuilder('tx')
      .where('tx.block_hash = :hash', { hash: microBlock.hash });

    if (type) {
      query.andWhere('tx.type = :type', { type });
    }

    if (functionName) {
      query.andWhere('tx.function = :function', { function: functionName });
    }

    if (sender_id) {
      query.andWhere('tx.sender_id = :sender_id', { sender_id });
    }

    if (recipient_id) {
      query.andWhere('tx.recipient_id = :recipient_id', { recipient_id });
    }

    if (contract_id) {
      query.andWhere('tx.contract_id = :contract_id', { contract_id });
    }

    if (caller_id) {
      query.andWhere('tx.caller_id = :caller_id', { caller_id });
    }

    if (orderBy) {
      query.orderBy(`tx.${orderBy}`, orderDirection || 'DESC');
    } else {
      query.orderBy('tx.micro_index', 'ASC');
    }

    query.limit(limit).offset(offset);

    return query.getMany();
  }
}

