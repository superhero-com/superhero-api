import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IPaginationOptions,
  paginate,
  Pagination,
} from 'nestjs-typeorm-paginate';
import { BclToken } from '../entities/bcl-token.entity';
import { BclTokenView } from '../entities/bcl-token.view';
import { BclTransaction } from '../entities/bcl-transaction.entity';
import { BclTokenDto } from '../dto/bcl-token.dto';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';

@Injectable()
export class BclTokensService {
  private readonly logger = new Logger(BclTokensService.name);

  constructor(
    @InjectRepository(BclTokenView)
    private readonly bclTokenViewRepository: Repository<BclTokenView>,
    @InjectRepository(BclToken)
    private readonly bclTokenRepository: Repository<BclToken>,
    @InjectRepository(BclTransaction)
    private readonly bclTransactionRepository: Repository<BclTransaction>,
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
    // Handle owner_address filter separately as it requires a subquery
    let ownedTokens: string[] = [];
    if (filters?.owner_address) {
      ownedTokens = await this.tokenHolderRepository
        .createQueryBuilder('token_holder')
        .where('token_holder.address = :owner_address', {
          owner_address: filters.owner_address,
        })
        .andWhere('token_holder.balance > 0')
        .select('token_holder.aex9_address')
        .distinct(true)
        .getRawMany()
        .then((res) => res.map((r) => r.aex9_address));

      if (ownedTokens.length === 0) {
        // Return empty result if no tokens found
        const page = typeof options.page === 'string' ? parseInt(options.page, 10) : (options.page || 1);
        const limit = typeof options.limit === 'string' ? parseInt(options.limit, 10) : (options.limit || 10);
        return {
          items: [],
          meta: {
            currentPage: page,
            itemCount: 0,
            itemsPerPage: limit,
            totalItems: 0,
            totalPages: 0,
          },
          links: {
            first: '',
            last: '',
            next: '',
            previous: '',
          },
          queryMs: 0,
        };
      }
    }

    // Use the view which already has latest transaction data and rank
    const queryBuilder = this.bclTokenViewRepository.createQueryBuilder('bcl_tokens_view');

    // Default filter: unlisted = false (unless explicitly set)
    if (filters?.unlisted !== undefined) {
      queryBuilder.where('bcl_tokens_view.unlisted = :unlisted', {
        unlisted: filters.unlisted,
      });
    } else {
      queryBuilder.where('bcl_tokens_view.unlisted = false');
    }

    // Apply filters
    if (filters?.search) {
      queryBuilder.andWhere('bcl_tokens_view.name ILIKE :search', {
        search: `%${filters.search}%`,
      });
    }

    if (filters?.factory_address) {
      queryBuilder.andWhere('bcl_tokens_view.factory_address = :factory_address', {
        factory_address: filters.factory_address,
      });
    }

    if (filters?.creator_address) {
      queryBuilder.andWhere('bcl_tokens_view.creator_address = :creator_address', {
        creator_address: filters.creator_address,
      });
    }

    if (filters?.collection && filters.collection !== 'all') {
      queryBuilder.andWhere('bcl_tokens_view.collection = :collection', {
        collection: filters.collection,
      });
    }

    if (ownedTokens.length > 0) {
      queryBuilder.andWhere('bcl_tokens_view.address IN (:...aex9_addresses)', {
        aex9_addresses: ownedTokens,
      });
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
    const orderDirection = order.toUpperCase() as 'ASC' | 'DESC';
    
    // Handle sorting for fields that come from JSONB
    // Need to handle NULL values properly - use addOrderBy for raw SQL expressions
    if (sortField === 'market_cap') {
      queryBuilder.addOrderBy(
        `(bcl_tokens_view.market_cap->>'ae')::numeric`,
        orderDirection,
        'NULLS LAST',
      );
    } else if (sortField === 'price') {
      queryBuilder.addOrderBy(
        `(bcl_tokens_view.buy_price->>'ae')::numeric`,
        orderDirection,
        'NULLS LAST',
      );
    } else {
      queryBuilder.addOrderBy(`bcl_tokens_view.${sortField}`, orderDirection);
    }

    const startTime = Date.now();
    const paginationResult = await paginate<BclTokenView>(
      queryBuilder,
      options,
    );
    const queryMs = Date.now() - startTime;

    // Transform to DTO format
    const items = paginationResult.items.map((item) => this.toDtoFromView(item));

    return {
      ...paginationResult,
      items,
      queryMs,
    };
  }

  /**
   * Transform token view entity to DTO
   */
  private toDtoFromView(token: BclTokenView): BclTokenDto {
    const buyPrice = token.buy_price || null;
    const sellPrice = token.sell_price || null;
    const marketCap = token.market_cap || null;
    const totalSupply = token.total_supply || '0';

    // Calculate price from buy_price
    const price = buyPrice?.ae ? buyPrice.ae.toString() : '0';
    const priceData = buyPrice || {};

    // Calculate sell_price
    const sellPriceValue = sellPrice?.ae ? sellPrice.ae.toString() : '0';
    const sellPriceData = sellPrice || {};

    // Calculate market_cap
    const marketCapValue = marketCap?.ae ? marketCap.ae.toString() : '0';
    const marketCapData = marketCap || {};

    return {
      sale_address: token.sale_address,
      unlisted: token.unlisted,
      last_tx_hash: token.last_tx_hash || '',
      last_sync_block_height: token.last_sync_block_height || 0,
      last_sync_tx_count: 0,
      tx_count: token.tx_count,
      holders_count: 0,
      factory_address: token.factory_address,
      create_tx_hash: token.create_tx_hash,
      dao_address: token.dao_address,
      creator_address: token.creator_address,
      beneficiary_address: token.beneficiary_address,
      bonding_curve_address: token.bonding_curve_address,
      dao_balance: token.dao_balance?.ae?.toString() || '0',
      owner_address: token.owner_address,
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals?.toString() || '18',
      collection: token.collection,
      price,
      price_data: priceData,
      sell_price: sellPriceValue,
      sell_price_data: sellPriceData,
      market_cap: marketCapValue,
      market_cap_data: marketCapData,
      total_supply: totalSupply,
      trending_score: token.trending_score?.toString() || '0',
      trending_score_update_at: token.trending_score_update_at,
      created_at: token.created_at,
      rank: token.rank,
      performance: token.performance || null,
    };
  }


  async findByAddress(address: string): Promise<BclTokenDto | null> {
    try {
      const token = await this.bclTokenViewRepository
        .createQueryBuilder('bcl_tokens_view')
        .where('bcl_tokens_view.sale_address = :address', { address })
        .orWhere('bcl_tokens_view.address = :address', { address })
        .orWhere('bcl_tokens_view.name = :address', { address })
        .orWhere('bcl_tokens_view.symbol = :address', { address })
        .getOne();

      if (!token) {
        this.logger.debug(`Token not found for address: ${address}`);
        return null;
      }

      return this.toDtoFromView(token);
    } catch (error: any) {
      this.logger.error(`Error finding token by address ${address}:`, error.stack);
      throw error;
    }
  }
}

