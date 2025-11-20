import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { BclToken } from '../entities/bcl-token.view';
import { BclTokenDto } from '../dto/bcl-token.dto';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';

@Injectable()
export class BclTokensService {
  private readonly logger = new Logger(BclTokensService.name);

  constructor(
    @InjectRepository(BclToken)
    private readonly bclTokenRepository: Repository<BclToken>,
    @InjectRepository(TokenHolder)
    private readonly tokenHolderRepository: Repository<TokenHolder>,
  ) {}

  async findAll(
    options: IPaginationOptions,
    filters?: {
      search?: string;
      factory_address?: string;
      creator_address?: string;
      owner_address?: string;
      collection?: 'all' | 'word' | 'number';
      unlisted?: boolean;
    },
    sortBy: string = 'rank',
    order: 'ASC' | 'DESC' = 'ASC',
  ): Promise<Pagination<BclTokenDto> & { queryMs: number }> {
    const queryBuilder = this.bclTokenRepository.createQueryBuilder('bcl_token');

    // Default filter: unlisted = false (unless explicitly set)
    if (filters?.unlisted !== undefined) {
      queryBuilder.where('bcl_token.unlisted = :unlisted', {
        unlisted: filters.unlisted,
      });
    } else {
      queryBuilder.where('bcl_token.unlisted = false');
    }

    // Apply filters
    if (filters?.search) {
      queryBuilder.andWhere('bcl_token.name ILIKE :search', {
        search: `%${filters.search}%`,
      });
    }

    if (filters?.factory_address) {
      queryBuilder.andWhere('bcl_token.factory_address = :factory_address', {
        factory_address: filters.factory_address,
      });
    }

    if (filters?.creator_address) {
      queryBuilder.andWhere('bcl_token.creator_address = :creator_address', {
        creator_address: filters.creator_address,
      });
    }

    if (filters?.collection && filters.collection !== 'all') {
      queryBuilder.andWhere('bcl_token.collection = :collection', {
        collection: filters.collection,
      });
    }

    if (filters?.owner_address) {
      // Query token_holders to find tokens owned by this address
      const ownedTokens = await this.tokenHolderRepository
        .createQueryBuilder('token_holder')
        .where('token_holder.address = :owner_address', {
          owner_address: filters.owner_address,
        })
        .andWhere('token_holder.balance > 0')
        .select('token_holder.aex9_address')
        .distinct(true)
        .getRawMany()
        .then((res) => res.map((r) => r.aex9_address));

      if (ownedTokens.length > 0) {
        queryBuilder.andWhere('bcl_token.address IN (:...aex9_addresses)', {
          aex9_addresses: ownedTokens,
        });
      } else {
        // If no tokens found, return empty result
        queryBuilder.andWhere('1 = 0');
      }
    }

    // Apply sorting
    const allowedSortFields = [
      'rank',
      'market_cap',
      'name',
      'price',
      'created_at',
      'trending_score',
      'tx_count',
      'holders_count',
    ];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'rank';
    queryBuilder.orderBy(`bcl_token.${sortField}`, order);

    const startTime = Date.now();
    const paginationResult = await paginate<BclToken>(
      queryBuilder,
      options,
    );
    const queryMs = Date.now() - startTime;

    // Transform to DTO format
    const items = paginationResult.items.map((item) => this.toDto(item));

    return {
      ...paginationResult,
      items,
      queryMs,
    };
  }

  private toDto(token: BclToken): BclTokenDto {
    return {
      sale_address: token.sale_address,
      unlisted: token.unlisted,
      last_sync_tx_count: token.last_sync_tx_count,
      tx_count: token.tx_count,
      holders_count: token.holders_count,
      factory_address: token.factory_address,
      create_tx_hash: token.create_tx_hash,
      dao_address: token.dao_address,
      creator_address: token.creator_address,
      beneficiary_address: token.beneficiary_address,
      bonding_curve_address: token.bonding_curve_address,
      dao_balance: token.dao_balance?.toString() || '0',
      owner_address: token.owner_address,
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals?.toString() || '18',
      collection: token.collection,
      price: token.price?.toString() || '0',
      price_data: token.price_data || {},
      sell_price: token.sell_price?.toString() || '0',
      sell_price_data: token.sell_price_data || {},
      market_cap: token.market_cap?.toString() || '0',
      market_cap_data: token.market_cap_data || {},
      total_supply: token.total_supply || '0',
      trending_score: token.trending_score?.toString() || '0',
      trending_score_update_at: token.trending_score_update_at,
      created_at: token.created_at,
      last_tx_hash: token.last_tx_hash || '',
      last_sync_block_height: token.last_sync_block_height || 0,
      rank: token.rank,
    };
  }

  async findByAddress(address: string): Promise<BclTokenDto | null> {
    try {
      const token = await this.bclTokenRepository
        .createQueryBuilder('bcl_token')
        .where('bcl_token.sale_address = :address', { address })
        .orWhere('bcl_token.address = :address', { address })
        .orWhere('bcl_token.name = :address', { address })
        .orWhere('bcl_token.symbol = :address', { address })
        .getOne();

      if (!token) {
        this.logger.debug(`Token not found for address: ${address}`);
        return null;
      }

      return this.toDto(token);
    } catch (error: any) {
      this.logger.error(`Error finding token by address ${address}:`, error.stack);
      throw error;
    }
  }
}

