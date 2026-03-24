import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { In, IsNull, Repository, SelectQueryBuilder } from 'typeorm';

import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import {
  ACTIVE_NETWORK,
  TOKEN_LIST_ELIGIBILITY_CONFIG,
  TRENDING_SCORE_CONFIG,
} from '@/configs';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue } from '@nestjs/bull';
import { CommunityFactory, initTokenSale, TokenSale } from 'bctsl-sdk';
import BigNumber from 'bignumber.js';
import { Queue } from 'bull';
import moment from 'moment';
import { TokenHolder } from './entities/token-holders.entity';
import { TokenEligibilityCounts } from './entities/token-eligibility-counts.entity';
import { Token } from './entities/token.entity';
import { PULL_TOKEN_INFO_QUEUE } from './queues/constants';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Post } from '@/social/entities/post.entity';
import { buildTokenMentionExistsSql } from '@/social/utils/token-mentions-sql.util';

type TokenContracts = {
  instance?: TokenSale;
  tokenContractInstance?: any;
  token?: Token;
  lastUsedAt?: number;
};

interface TrendingSignalMetric {
  raw: number;
  cap: number;
  normalized: number;
}

interface TrendingMetrics {
  window_hours: number;
  last_activity_at: Date | null;
  last_trade_at: Date | null;
  last_social_activity_at: Date | null;
  age_hours_since_last_activity: number;
  decay_multiplier: number;
  trading_signals: {
    active_wallets: TrendingSignalMetric;
    buy_count: TrendingSignalMetric;
    sell_count: TrendingSignalMetric;
    volume_ae: TrendingSignalMetric;
  };
  social_signals: {
    mention_posts: TrendingSignalMetric;
    mention_comments: TrendingSignalMetric;
    unique_authors: TrendingSignalMetric;
    tips_count: TrendingSignalMetric;
    tips_amount_ae: TrendingSignalMetric;
    reads: TrendingSignalMetric;
  };
  component_scores: {
    trading: number;
    social: number;
    pre_decay: number;
  };
  trending_score: {
    formula: string;
    result: number;
    pre_decay: number;
  };
}

export interface TokenTrendingEligibilityBreakdown {
  sale_address: string;
  symbol: string;
  holders_count: number;
  post_count: number;
  stored_post_count: number;
  content_post_count: number;
  trade_count: number;
  thresholds: {
    min_holders: number;
    min_posts: number;
    min_trades: number;
  };
  passes: {
    holders: boolean;
    posts: boolean;
    trades: boolean;
    eligible: boolean;
  };
}

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  private readonly contractCallTimeoutMs = Number(
    process.env.TOKEN_CONTRACT_CALL_TIMEOUT_MS || 30_000,
  );
  private readonly contractNotPresentMaxAttempts = Number(
    process.env.TOKEN_CONTRACT_NOT_PRESENT_MAX_ATTEMPTS || 4,
  );
  private readonly contractNotPresentRetryDelayMs = Number(
    process.env.TOKEN_CONTRACT_NOT_PRESENT_RETRY_DELAY_MS || 750,
  );
  private readonly maxHoldersPages = Number(
    process.env.TOKEN_HOLDERS_MAX_PAGES || 300,
  );
  contracts: Record<Encoded.ContractAddress, TokenContracts> = {};
  totalTokens = 0;
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHolder)
    private tokenHoldersRepository: Repository<TokenHolder>,

    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,

    @InjectRepository(Post)
    private postsRepository: Repository<Post>,

    @InjectRepository(TokenEligibilityCounts)
    private tokenEligibilityCountsRepository: Repository<TokenEligibilityCounts>,

    private aeSdkService: AeSdkService,

    private tokenWebsocketGateway: TokenWebsocketGateway,

    private aePricingService: AePricingService,

    private communityFactoryService: CommunityFactoryService,

    @InjectQueue(PULL_TOKEN_INFO_QUEUE)
    private readonly pullTokenInfoQueue: Queue,
  ) {
    this.init();
  }

  factoryContract: CommunityFactory;
  async init() {
    // await this.findAndRemoveDuplicatedTokensBaseSaleAddress();
  }

  async findAndRemoveDuplicatedTokensBaseSaleAddress() {
    // remove all the tokens where sale_address is null
    await this.tokensRepository.delete({
      sale_address: IsNull(),
    });

    const duplicatedTokensQuery = `
      SELECT sale_address, COUNT(*) as count
      FROM token
      WHERE sale_address IS NOT NULL
      GROUP BY sale_address
      HAVING COUNT(*) > 1
    `;

    const duplicatedTokens = await this.tokensRepository.query(
      duplicatedTokensQuery,
    );
    // delete duplicated tokens
    for (const token of duplicatedTokens) {
      await this.tokensRepository.delete(token.id);
    }
  }

  findAll(): Promise<Token[]> {
    return this.tokensRepository.find();
  }

  async update(token: Token, data): Promise<Token> {
    await this.tokensRepository.update(token.sale_address, data);
    return this.findByAddress(token.sale_address);
  }

  async findById(sale_address: string): Promise<Token | null> {
    return this.tokensRepository.findOneBy({ sale_address });
  }

  async findByNameOrSymbol(name: string) {
    return this.tokensRepository
      .createQueryBuilder('token')
      .where('token.name = :name', { name })
      .orWhere('token.symbol = :name', { name })
      .getOne();
  }

  async findByAddress(
    address: string,
    withoutRank = false,
  ): Promise<Token | null> {
    const token = await this.tokensRepository
      .createQueryBuilder('token')
      .where('token.address = :address', { address })
      .orWhere('token.sale_address = :address', { address })
      .orWhere('token.name = :address', { address })
      .orWhere('token.symbol = :address', { address })
      .getOne();

    if (!token) {
      return null;
    }

    if (withoutRank) {
      return token;
    }

    const rankedQuery = `
      WITH ranked_tokens AS (
        SELECT 
          sale_address,
          CAST(RANK() OVER (
            ORDER BY 
              CASE WHEN market_cap = 0 THEN 1 ELSE 0 END,
              market_cap DESC,
              created_at ASC
          ) AS INTEGER) as rank
        FROM token
        WHERE factory_address = '${token.factory_address}'
      )
      SELECT
        ranked_tokens.rank,
        row_to_json(token_performance_view.*) as performance
      FROM ranked_tokens
      LEFT JOIN token_performance_view ON ranked_tokens.sale_address = token_performance_view.sale_address
      WHERE ranked_tokens.sale_address = '${token.sale_address}'
    `;

    const [rankResult] = await this.tokensRepository.query(rankedQuery);
    return {
      ...token,
      rank: rankResult?.rank,
      performance: rankResult?.performance ?? null,
    } as Token & { rank: number; performance: unknown };
  }

  findOne(sale_address: string): Promise<Token | null> {
    return this.tokensRepository.findOneBy({ sale_address });
  }

  async syncTokenPrice(token: Token): Promise<void> {
    try {
      const data = await this.getTokeLivePrice(token);

      await this.tokensRepository.update(token.sale_address, data as any);
      // update token ranks

      // re-fetch token
      this.tokenWebsocketGateway?.handleTokenUpdated({
        sale_address: token.sale_address,
        data,
      });
    } catch (error) {
      //
    }
  }

  async getToken(address: string): Promise<Token> {
    const existingToken = await this.findByAddress(address);

    if (existingToken) {
      return existingToken;
    }

    if (!address.startsWith('ct_')) {
      // find by name or symbol TODO:
      return this.pullLatestCreatedTokensByNameOrSymbol(address);
    }

    return this.createToken(address as Encoded.ContractAddress);
  }

  async getTokenAex9Address(token: Token | null | undefined): Promise<string> {
    if (!token?.sale_address) {
      return null;
    }

    if (token.address) {
      return token.address;
    }
    const contracts = await this.getTokenContractsBySaleAddress(
      token.sale_address as Encoded.ContractAddress,
    );
    const instance = contracts?.instance;
    if (!instance) {
      return null;
    }

    const priceData = await this.getTokeLivePrice(token);

    await this.tokensRepository.update(token.sale_address, priceData);

    return priceData.address;
  }

  async createToken(
    saleAddress: Encoded.ContractAddress,
  ): Promise<Token | null> {
    if (!saleAddress?.startsWith('ct_')) {
      this.logger.error(
        'saleAddress is not a valid token address',
        saleAddress,
      );
      return null;
    }
    const contracts = await this.getTokenContractsBySaleAddress(saleAddress);

    if (!contracts?.instance) {
      return null;
    }

    const { instance } = contracts;

    const [tokenMetaInfo] = await Promise.all([
      instance.metaInfo().catch(() => {
        return { token: {} };
      }),
    ]);

    const tokenData: any = {
      sale_address: saleAddress,
      ...(tokenMetaInfo?.token || {}),
    };

    if (!tokenData.name) {
      return null;
    }

    // prevent duplicate tokens
    const existingToken = await this.findByAddress(saleAddress);
    if (existingToken) {
      return existingToken;
    }

    // prevent duplicate tokens by symbol
    if (tokenData?.symbol) {
      await this.tokensRepository.delete({
        symbol: tokenData.symbol,
        name: tokenData.name,
      });
    }

    // Use upsert to handle race conditions where token might be created concurrently
    await this.tokensRepository.upsert(tokenData, {
      conflictPaths: ['sale_address'],
      skipUpdateIfNoValuesChanged: true,
    });
    const newToken = await this.findByAddress(saleAddress);
    if (!newToken) {
      throw new Error(
        `Failed to create or retrieve token for sale address: ${saleAddress}`,
      );
    }
    const factoryAddress = await this.updateTokenFactoryAddress(newToken);

    if (!factoryAddress) {
      await this.tokensRepository.delete(newToken.sale_address);
      throw new Error(
        `for sale address:${saleAddress}, failed to update factory address`,
      );
    }
    await this.syncTokenPrice(newToken);

    return this.findByAddress(newToken.sale_address);
  }

  async updateTokenFactoryAddress(
    token: Token,
  ): Promise<Encoded.ContractAddress> {
    if (token.factory_address) {
      return token.factory_address as Encoded.ContractAddress;
    }

    let totalRetries = 0;
    const maxRetries = 3;
    const retryDelay = 5000; // 5 seconds

    while (totalRetries < maxRetries) {
      const contractInfo = await fetchJson(
        `${ACTIVE_NETWORK.middlewareUrl}/v2/contracts/${token.sale_address}`,
      );
      const response = await fetchJson(
        `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions/${contractInfo.source_tx_hash}`,
      );

      if (response?.tx?.contract_id) {
        const factory_address = response?.tx?.contract_id;
        await this.updateTokenMetaDataFromCreateTx(
          token,
          camelcaseKeysDeep(response),
        );
        return factory_address as Encoded.ContractAddress;
      }

      this.logger.error(
        `updateTokenFactoryAddress->error:: retry ${totalRetries + 1}/${maxRetries}`,
        response,
        contractInfo,
      );

      totalRetries++;
      if (totalRetries < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    return null;
  }

  async getTokenContracts(token: Token) {
    return this.getTokenContractsBySaleAddress(
      token.sale_address as Encoded.ContractAddress,
    );
  }

  async getTokenContractsBySaleAddress(
    saleAddress: Encoded.ContractAddress,
  ): Promise<TokenContracts | undefined> {
    if (this.contracts[saleAddress] && this.contracts[saleAddress].instance) {
      this.contracts[saleAddress].lastUsedAt = Date.now();
      return this.contracts[saleAddress];
    }

    for (
      let attempt = 1;
      attempt <= this.contractNotPresentMaxAttempts;
      attempt++
    ) {
      try {
        const { instance } = await initTokenSale(
          this.aeSdkService.sdk as any,
          saleAddress,
        );
        const tokenContractInstance = await instance?.tokenContractInstance();

        this.contracts[saleAddress] = {
          ...(this.contracts[saleAddress] || {}),
          instance,
          tokenContractInstance,
          lastUsedAt: Date.now(),
        };

        return this.contracts[saleAddress];
      } catch (error: any) {
        const isNotPresent = this.isContractNotPresentError(error);
        const hasRetry =
          isNotPresent && attempt < this.contractNotPresentMaxAttempts;
        const isUnsupportedSaleContractError =
          error?.name === 'BytecodeMismatchError' ||
          error?.message?.includes(
            'Contract ACI do not correspond to the bytecode deployed on the chain',
          ) ||
          error?.message?.includes('Trying to call undefined function') ||
          error?.message?.includes('function name: sale_type');

        if (isUnsupportedSaleContractError) {
          this.logger.warn(
            `getTokenContractsBySaleAddress->unsupported:: ${saleAddress} (${error.message})`,
          );
          return undefined;
        }

        if (hasRetry) {
          const delayMs = this.contractNotPresentRetryDelayMs * attempt;
          this.logger.warn(
            `getTokenContractsBySaleAddress->not_present:: ${saleAddress}, attempt ${attempt}/${this.contractNotPresentMaxAttempts}, retrying in ${delayMs}ms`,
          );
          await this.sleep(delayMs);
          continue;
        }

        this.logger.error(
          `getTokenContractsBySaleAddress->error:: ${saleAddress}`,
          error,
          error.stack,
        );
        return undefined;
      }
    }

    return undefined;
  }

  async getTokeLivePrice(token: Token): Promise<
    Partial<{
      price: BigNumber;
      sell_price: BigNumber;
      total_supply: BigNumber;
      market_cap: BigNumber;
      address: string;
      name: string;
      symbol: string;
      beneficiary_address: string;
      bonding_curve_address: string;
      owner_address: string;
      dao_balance: BigNumber;
      price_data: any;
      sell_price_data: any;
      market_cap_data: any;
    }>
  > {
    const contract = await this.getTokenContracts(token);
    if (!contract) {
      return {};
    }
    const { instance, tokenContractInstance } = contract;

    const [total_supply, price, sell_price, metaInfo] = await Promise.all([
      tokenContractInstance
        .total_supply?.()
        .then((res) => new BigNumber(res.decodedResult))
        .catch((error) => {
          this.logger.error(
            `getTokeLivePrice->error:: total_supply`,
            token.sale_address,
            error,
            error.stack,
          );
          return new BigNumber(0);
        }),
      instance
        .price(1)
        .then((res: string) => new BigNumber(res || '0'))
        .catch(() => {
          return new BigNumber(0);
        }),
      instance
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        .sellReturn?.('1' as string)
        .then((res: string) => new BigNumber(res || '0'))
        .catch(() => {
          return new BigNumber(0);
        }),
      instance.metaInfo().catch((error) => {
        this.logger.error(
          `getTokeLivePrice->error:: metaInfo`,
          token.sale_address,
          error,
          error.stack,
        );
        return { token: {} };
      }),
    ]);

    const market_cap = total_supply.multipliedBy(price);

    const [price_data, sell_price_data, market_cap_data, dao_balance] =
      await Promise.all([
        this.aePricingService.getPriceData(price),
        this.aePricingService.getPriceData(sell_price),
        this.aePricingService.getPriceData(market_cap),
        metaInfo?.beneficiary
          ? this.aeSdkService.sdk.getBalance(metaInfo.beneficiary)
          : Promise.resolve('0'),
      ]);

    return {
      price,
      sell_price,
      sell_price_data,
      total_supply,
      price_data,
      market_cap,
      market_cap_data,
      address:
        metaInfo?.token?.address || tokenContractInstance?.$options.address,
      name: metaInfo?.token?.name,
      symbol: metaInfo?.token?.symbol,
      beneficiary_address: metaInfo?.beneficiary,
      bonding_curve_address: metaInfo?.bondingCurve,
      owner_address: metaInfo?.owner,
      dao_balance: new BigNumber(dao_balance),
    };
  }

  async updateTokenMetaDataFromCreateTx(
    token: Token,
    transaction: ITransaction,
  ): Promise<Encoded.ContractAddress> {
    const tokenData = {
      factory_address: transaction.tx?.contractId,
      creator_address: transaction.tx?.callerId,
      created_at: moment(transaction.microTime).toDate(),
    };
    if (transaction?.tx.arguments?.[0]?.value) {
      tokenData['collection'] = transaction?.tx.arguments[0].value;
    }
    await this.tokensRepository.update(token.sale_address, tokenData);

    return transaction.tx.contractId;
  }

  async queryTokensWithRanks(
    queryBuilder: any,
    limit: number = 20,
    page: number = 1,
    orderBy: string = 'rank',
    orderDirection: 'ASC' | 'DESC' = 'ASC',
  ) {
    // Get the base query and parameters
    const subQuery = queryBuilder.getQuery();
    const parameters = queryBuilder.getParameters();

    // Replace all parameter placeholders with actual values
    let finalSubQuery = subQuery;
    Object.entries(parameters).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        // Handle array parameters by joining them with commas and wrapping in quotes
        if (value.length === 0) {
          // Handle empty arrays by replacing with a condition that always evaluates to false
          finalSubQuery = finalSubQuery.replace(
            `IN (:...${key})`,
            "IN (SELECT '' WHERE 1 = 0)",
          );
          finalSubQuery = finalSubQuery.replace(`:...${key}`, 'NULL');
        } else {
          const arrayValues = value.map((v) => `'${v}'`).join(',');
          finalSubQuery = finalSubQuery.replace(`:...${key}`, arrayValues);
        }
      } else {
        finalSubQuery = finalSubQuery.replace(`:${key}`, `'${value}'`);
      }
    });

    if (orderBy === 'market_cap') {
      orderBy = 'rank';
      // reverse the order direction
      orderDirection = orderDirection === 'ASC' ? 'DESC' : 'ASC';
    }

    // Get total count of filtered items
    const countQuery = `
      WITH filtered_tokens AS (
        ${finalSubQuery}
      )
      SELECT COUNT(*) as total
      FROM filtered_tokens
    `;
    const [{ total }] = await this.tokensRepository.query(countQuery);
    const totalItems = parseInt(total, 10);
    const totalPages = Math.ceil(totalItems / limit);
    const orderClause =
      orderBy === 'trending_score'
        ? `all_ranked_tokens.trending_score ${orderDirection},
           CASE
             WHEN all_ranked_tokens.trending_score = 0
               THEN all_ranked_tokens.created_at
             ELSE NULL
           END DESC,
           all_ranked_tokens.created_at DESC`
        : `all_ranked_tokens.${orderBy} ${orderDirection}`;

    // Create a new query that includes the rank
    const rankedQuery = `
      WITH all_ranked_tokens AS (
        SELECT 
          token.*,
          CAST(RANK() OVER (
            ORDER BY 
              CASE WHEN token.market_cap = 0 THEN 1 ELSE 0 END,
              token.market_cap DESC,
              token.created_at ASC
          ) AS INTEGER) as rank
        FROM token
        WHERE token.unlisted = false
      ),
      filtered_tokens AS (
        ${finalSubQuery}
      )
      SELECT 
        all_ranked_tokens.*,
        row_to_json(token_performance_view.*) as performance
      FROM all_ranked_tokens
      INNER JOIN filtered_tokens ON all_ranked_tokens.sale_address = filtered_tokens.sale_address
      LEFT JOIN token_performance_view ON all_ranked_tokens.sale_address = token_performance_view.sale_address
      ORDER BY ${orderClause}
      LIMIT ${limit}
      OFFSET ${(page - 1) * limit}
    `;

    const result = await this.tokensRepository.query(rankedQuery);

    return {
      items: result,
      meta: {
        currentPage: page,
        itemCount: result.length,
        itemsPerPage: limit,
        totalItems,
        totalPages,
      },
    };
  }

  private buildEligibilityTradeCountsSubquery(): string {
    return `
      (
        SELECT
          tx.sale_address,
          COUNT(*) AS trade_count
        FROM transactions tx
        WHERE tx.tx_type IN ('buy', 'sell')
        GROUP BY tx.sale_address
      )
    `.trim();
  }

  applyListEligibilityFilters(
    queryBuilder: SelectQueryBuilder<Token>,
  ): SelectQueryBuilder<Token> {
    queryBuilder.leftJoin(
      TokenEligibilityCounts,
      'eligibility_post_counts',
      'eligibility_post_counts.symbol = UPPER(token.symbol)',
    );

    queryBuilder.leftJoin(
      this.buildEligibilityTradeCountsSubquery(),
      'eligibility_trade_counts',
      'eligibility_trade_counts.sale_address = token.sale_address',
    );

    return queryBuilder.andWhere(
      `(
        token.holders_count >= :eligibilityMinHolders
        AND COALESCE(eligibility_post_counts.post_count, 0) >= :eligibilityMinPosts
        AND COALESCE(eligibility_trade_counts.trade_count, 0) >= :eligibilityMinTrades
      )`,
      {
        eligibilityMinHolders: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_HOLDERS,
        eligibilityMinPosts:
          TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TOKEN_POSTS_ALL_TIME,
        eligibilityMinTrades:
          TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TRADES_ALL_TIME,
      },
    );
  }

  async getTrendingEligibilityBreakdown(
    address: string,
  ): Promise<TokenTrendingEligibilityBreakdown> {
    const token = await this.findByAddress(address);

    if (!token) {
      throw new NotFoundException(`Token with address ${address} not found`);
    }

    const normalizedSymbol = (token.symbol || '').trim().toUpperCase();
    const [counts, tradeCounts] = await Promise.all([
      this.tokenEligibilityCountsRepository.findOne({
        where: { symbol: normalizedSymbol },
      }),
      this.tokensRepository.query(
        `
          SELECT COUNT(*) AS trade_count
          FROM transactions tx
          WHERE tx.sale_address = $1
            AND tx.tx_type IN ('buy', 'sell')
        `,
        [token.sale_address],
      ),
    ]);

    const rawBreakdown = tradeCounts[0] ?? {};

    const holdersCount = Number(token.holders_count || 0);
    const postCount = Number(counts?.post_count || 0);
    const tradeCount = Number(rawBreakdown?.trade_count || 0);

    const passes = {
      holders: holdersCount >= TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_HOLDERS,
      posts: postCount >= TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TOKEN_POSTS_ALL_TIME,
      trades: tradeCount >= TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TRADES_ALL_TIME,
      eligible: false,
    };
    passes.eligible = passes.holders && passes.posts && passes.trades;

    return {
      sale_address: token.sale_address,
      symbol: token.symbol,
      holders_count: holdersCount,
      post_count: postCount,
      stored_post_count: Number(counts?.stored_post_count || 0),
      content_post_count: Number(counts?.content_post_count || 0),
      trade_count: tradeCount,
      thresholds: {
        min_holders: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_HOLDERS,
        min_posts: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TOKEN_POSTS_ALL_TIME,
        min_trades: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TRADES_ALL_TIME,
      },
      passes,
    };
  }

  async getTokenRanks(tokenIds: string[]): Promise<Map<string, number>> {
    if (!tokenIds.length) {
      return new Map();
    }
    const factory = await this.communityFactoryService.getCurrentFactory();
    const rankedQuery = `
      WITH ranked_tokens AS (
        SELECT 
          t.*,
          CAST(RANK() OVER (
            ORDER BY 
              CASE WHEN t.market_cap = 0 THEN 1 ELSE 0 END,
              t.market_cap DESC,
              t.created_at ASC
          ) AS INTEGER) as rank
        FROM token t
        WHERE t.factory_address = '${factory.address}'
        AND t.unlisted = false
      )
      SELECT * FROM ranked_tokens WHERE sale_address IN (${tokenIds.join(',')})
    `;

    const result = await this.tokensRepository.query(rankedQuery);
    return new Map(result.map((token) => [token.sale_address, token.rank]));
  }

  async getTokenRanksByAex9Address(
    aex9Addresses: string[],
  ): Promise<Map<string, number>> {
    if (!aex9Addresses.length) {
      return new Map();
    }
    const factory = await this.communityFactoryService.getCurrentFactory();
    const rankedQuery = `
      WITH ranked_tokens AS (
        SELECT 
          t.*,
          CAST(RANK() OVER (
            ORDER BY 
              CASE WHEN t.market_cap = 0 THEN 1 ELSE 0 END,
              t.market_cap DESC,
              t.created_at ASC
          ) AS INTEGER) as rank
        FROM token t
        WHERE t.factory_address = '${factory.address}'
        AND t.unlisted = false
      )
      SELECT * FROM ranked_tokens WHERE address IN ('${aex9Addresses.join("','")}')
    `;

    const result = await this.tokensRepository.query(rankedQuery);
    return new Map(result.map((token) => [token.address, token.rank]));
  }

  async getTokensByAex9Address(aex9Addresses: string[]): Promise<Token[]> {
    if (!aex9Addresses.length) {
      return [];
    }
    return this.tokensRepository.find({
      where: { address: In(aex9Addresses) },
    });
  }

  async createTokenFromRawTransaction(rawTransaction: any): Promise<Token> {
    const tx = rawTransaction.tx;
    const factory = await this.communityFactoryService.getCurrentFactory();
    if (
      tx.function !== 'create_community' ||
      tx.return_type === 'revert' ||
      tx.return?.value?.length < 2
    ) {
      return null;
    }
    if (
      // If it's not supported collection, skip
      !Object.keys(factory.collections).includes(tx.arguments[0].value)
    ) {
      return null;
    }
    const daoAddress = tx?.return?.value[0]?.value;
    const saleAddress = tx?.return?.value[1]?.value;

    const tokenName = tx?.arguments?.[1]?.value;
    let tokenExists = await this.findByNameOrSymbol(tokenName);

    if (
      !!tokenExists?.sale_address &&
      tokenExists.sale_address !== saleAddress
    ) {
      // delete token
      await this.tokensRepository.delete(tokenExists.sale_address);
      tokenExists = undefined;
    }

    const tokenData = {
      total_supply: new BigNumber(0),
      holders_count: 0,
      address: null,
      ...(tokenExists || {}),
      dao_address: daoAddress,
      sale_address: saleAddress,
      factory_address: factory.address,
      creator_address:
        tx?.callerId || tx?.caller_id || tokenExists?.creator_address,
      created_at: moment(
        rawTransaction?.microTime ||
          rawTransaction?.micro_time ||
          tokenExists?.created_at,
      ).toDate(),
      name: tokenName,
      symbol: tokenName,
      create_tx_hash: rawTransaction?.hash,
    };

    const existingTokenBySaleAddress = await this.findOne(saleAddress);
    const isNewToken = !existingTokenBySaleAddress;

    // Mirror createToken() so concurrent requests converge instead of surfacing
    // duplicate-key errors when they race to create the same row.
    await this.tokensRepository.upsert(tokenData, {
      conflictPaths: ['sale_address'],
      skipUpdateIfNoValuesChanged: true,
    });
    const token = await this.findOne(saleAddress);
    if (!token) {
      throw new Error(
        `Failed to create or retrieve token for sale address: ${saleAddress}`,
      );
    }

    await this.pullTokenInfoQueue.add(
      {
        saleAddress: token.sale_address,
      },
      {
        jobId: `pullTokenInfo-${token.sale_address}`,
        lifo: isNewToken,
        removeOnComplete: true,
      },
    );

    return token;
  }

  async pullLatestCreatedTokensByNameOrSymbol(name: string): Promise<Token> {
    const factory = await this.communityFactoryService.getCurrentFactory();

    try {
      const queryString = new URLSearchParams({
        direction: 'backward',
        limit: '100',
        type: 'contract_call',
        contract: factory.address,
      }).toString();
      const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
      const result = await fetchJson(url);
      const transactions = result.data;

      for (const transaction of transactions) {
        const tokenName = transaction?.tx?.arguments?.[1]?.value;
        if (tokenName === name) {
          // TODO: need to save the transaction too
          return this.createTokenFromRawTransaction(transaction);
        }
      }
    } catch (error: any) {
      this.logger.error(
        `pullLatestCreatedTokensByNameOrSymbol->error::`,
        error,
        error.stack,
      );
    }

    return null;
  }

  async loadAndSaveTokenHoldersFromMdw(saleAddress: Encoded.ContractAddress) {
    const token = await this.getToken(saleAddress);
    if (!token) {
      this.logger.warn(
        `SyncTokenHoldersQueue: token not found for ${saleAddress}, skipping holders sync`,
      );
      return;
    }

    const aex9Address =
      token?.address || (await this.getTokenAex9Address(token));
    if (!aex9Address) {
      this.logger.warn(
        `SyncTokenHoldersQueue: aex9 address unavailable for ${saleAddress}, skipping holders sync`,
      );
      return;
    }

    const { holders: totalHolders, truncated } = await this._loadHoldersData(
      token,
      aex9Address,
    );

    if (truncated) {
      this.logger.warn(
        `SyncTokenHoldersQueue: skipping save for ${aex9Address} (partial data, max pages reached); holders_count unchanged`,
      );
      return;
    }

    const uniqueHolders = Array.from(
      new Map(totalHolders.map((holder) => [holder.id, holder])).values(),
    );

    if (uniqueHolders.length > 0) {
      await this.tokenHoldersRepository.delete({
        aex9_address: aex9Address,
      });
      await this.tokenHoldersRepository.upsert(uniqueHolders, {
        conflictPaths: ['id'],
        skipUpdateIfNoValuesChanged: true,
      });
    }
    await this.tokensRepository.update(token.sale_address, {
      holders_count: uniqueHolders.length,
    });
  }

  async _loadHoldersData(
    token: Token,
    aex9Address: string,
  ): Promise<{
    holders: Array<{
      id: string;
      aex9_address: string;
      address: string;
      balance: BigNumber;
    }>;
    truncated: boolean;
  }> {
    const _holders = await this._loadHoldersFromContract(token, aex9Address);
    if (_holders.length > 0) {
      return { holders: _holders, truncated: false };
    }
    this.logger.warn(
      `SyncTokenHoldersQueue: falling back to middleware balances for ${aex9Address}`,
    );
    return this.loadData(
      token,
      aex9Address,
      `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${aex9Address}/balances?by=amount&limit=100`,
    );
  }

  async loadData(
    token: Token,
    aex9Address: string,
    url: string,
    totalHolders: Array<{
      id: string;
      aex9_address: string;
      address: string;
      balance: BigNumber;
    }> = [],
    page = 1,
  ): Promise<{
    holders: Array<{
      id: string;
      aex9_address: string;
      address: string;
      balance: BigNumber;
    }>;
    truncated: boolean;
  }> {
    try {
      if (page > this.maxHoldersPages) {
        this.logger.error(
          `SyncTokenHoldersQueue:max pages reached for ${aex9Address} (${this.maxHoldersPages})`,
        );
        return { holders: totalHolders, truncated: true };
      }

      const response = await fetchJson(url);
      if (!response.data) {
        this.logger.error(
          `SyncTokenHoldersQueue:failed to load data from url::${url}`,
        );
        this.logger.error(`SyncTokenHoldersQueue:response::`, response);
        return { holders: totalHolders, truncated: totalHolders.length > 0 };
      }
      const holders = response.data.filter((item) => item.amount > 0);
      this.logger.debug(
        `SyncTokenHoldersQueue->holders:${holders.length}`,
        url,
      );

      for (const holder of holders) {
        try {
          const holderUrl = `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${aex9Address}/balances/${holder.account_id}`;
          const holderData = await fetchJson(holderUrl);
          if (!holderData?.amount) {
            this.logger.warn(
              `SyncTokenHoldersQueue->holderData:${holderUrl}`,
              holderData,
            );
          }
          totalHolders.push({
            id: `${holderData?.account || holder.account_id}_${aex9Address}`,
            aex9_address: aex9Address,
            address: holderData?.account || holder.account_id,
            balance: new BigNumber(holderData?.amount || 0),
          });
        } catch (error: any) {
          this.logger.error(
            `SyncTokenHoldersQueue->error:${error.message}`,
            error,
            error.stack,
          );
        }
      }

      if (response.next) {
        return this.loadData(
          token,
          aex9Address,
          `${ACTIVE_NETWORK.middlewareUrl}${response.next}`,
          totalHolders,
          page + 1,
        );
      }

      return { holders: totalHolders, truncated: false };
    } catch (error: any) {
      this.logger.error(`SyncTokenHoldersQueue->error`, error, error.stack);
      return {
        holders: totalHolders,
        truncated: totalHolders.length > 0,
      };
    }
  }

  async _loadHoldersFromContract(token: Token, aex9Address: string) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const contracts = await this.getTokenContractsBySaleAddress(
          token.sale_address as Encoded.ContractAddress,
        );
        const tokenContractInstance = contracts?.tokenContractInstance;

        if (!tokenContractInstance) {
          this.logger.warn(
            `SyncTokenHoldersQueue->_loadHoldersFromContract: contract instance unavailable for ${aex9Address}, switching to middleware`,
          );
          return [];
        }

        const holderBalances = await this.withTimeout<any>(
          tokenContractInstance.balances(),
          this.contractCallTimeoutMs,
          `balances() timeout for ${aex9Address}`,
        );
        const holders = Array.from(holderBalances.decodedResult)
          .map(([key, value]: any) => ({
            id: `${key}_${aex9Address}`,
            aex9_address: aex9Address,
            address: key,
            balance: new BigNumber(value),
          }))
          .filter((item) => item.balance.gt(0))
          .sort((a, b) => b.balance.minus(a.balance).toNumber());

        return holders || [];
      } catch (error: any) {
        const isOutOfGasError = this.isOutOfGasError(error);
        const isTimeoutError = error?.message?.includes('timeout');

        if (isOutOfGasError) {
          this.logger.warn(
            `SyncTokenHoldersQueue->_loadHoldersFromContract: out of gas for ${aex9Address}, switching to middleware`,
          );
          return [];
        }

        if (attempt < maxAttempts) {
          const waitMs = 500 * attempt;
          this.logger.warn(
            `SyncTokenHoldersQueue->_loadHoldersFromContract: attempt ${attempt}/${maxAttempts} failed for ${aex9Address}${isTimeoutError ? ' (timeout)' : ''}, retrying in ${waitMs}ms`,
          );
          await this.sleep(waitMs);
          continue;
        }

        this.logger.error(
          `SyncTokenHoldersQueue->_loadHoldersFromContract:failed to load holders from contract`,
          error,
          error.stack,
        );
        return [];
      }
    }

    return [];
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
  ): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(errorMessage)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }

  private isOutOfGasError(error: any): boolean {
    const message = error?.message?.toLowerCase?.() || '';
    return (
      message.includes('out of gas') || error?.name === 'NodeInvocationError'
    );
  }

  private isContractNotPresentError(error: any): boolean {
    const message = `${error?.message || ''} ${error?.reason || ''}`.toLowerCase();
    return message.includes('contract not found') || message.includes('not_present');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeCappedValue(raw: number, cap: number): number {
    if (!Number.isFinite(raw) || raw <= 0 || cap <= 0) {
      return 0;
    }

    return Math.log1p(Math.min(raw, cap)) / Math.log1p(cap);
  }

  private buildTrendingMetric(raw: number, cap: number): TrendingSignalMetric {
    return {
      raw,
      cap,
      normalized: this.normalizeCappedValue(raw, cap),
    };
  }

  private getLatestDate(
    ...dates: Array<Date | string | null | undefined>
  ): Date | null {
    const validDates = dates
      .filter(Boolean)
      .map((value) => new Date(value as Date | string))
      .filter((value) => !Number.isNaN(value.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());

    return validDates[0] ?? null;
  }

  async updateTrendingScoresForSymbols(symbols: string[]): Promise<void> {
    const normalizedSymbols = [
      ...new Set(
        symbols
          .map((symbol) => (symbol || '').trim().toUpperCase())
          .filter(Boolean),
      ),
    ];

    if (!normalizedSymbols.length) {
      return;
    }

    const tokens = await this.tokensRepository
      .createQueryBuilder('token')
      .where('token.unlisted = false')
      .andWhere('UPPER(token.symbol) IN (:...symbols)', {
        symbols: normalizedSymbols,
      })
      .getMany();

    if (!tokens.length) {
      return;
    }

    await this.updateMultipleTokensTrendingScores(tokens);
  }

  /**
   * Calculate 24-hour trending metrics for a token
   */
  async calculateTokenTrendingMetrics(token: Token): Promise<TrendingMetrics> {
    const windowStart = moment()
      .subtract(TRENDING_SCORE_CONFIG.WINDOW_HOURS, 'hours')
      .toDate();
    const windowStartDate = moment(windowStart).format('YYYY-MM-DD');
    const normalizedSymbol = (token.symbol || '').trim().toUpperCase();

    const [tradeRows, socialRows] = await Promise.all([
      this.transactionsRepository.query(
        `
          SELECT
            COUNT(DISTINCT t.address) AS active_wallets,
            COUNT(*) FILTER (WHERE t.tx_type = 'buy') AS buy_count,
            COUNT(*) FILTER (WHERE t.tx_type = 'sell') AS sell_count,
            COALESCE(
              SUM(
                CASE
                  WHEN t.tx_type IN ('buy', 'sell', 'create_community')
                    THEN CAST(NULLIF(t.amount->>'ae', 'NaN') AS DECIMAL)
                  ELSE 0
                END
              ),
              0
            ) AS volume_ae,
            MAX(t.created_at) AS last_trade_at
          FROM transactions t
          WHERE t.sale_address = $1
            AND t.created_at >= $2
        `,
        [token.sale_address, windowStart],
      ),
      this.postsRepository.query(
        `
          WITH RECURSIVE mentioned_root_posts AS (
            SELECT post.id, post.post_id, post.sender_address, post.created_at
            FROM posts post
            WHERE post.is_hidden = false
              AND post.created_at >= $1
              AND post.post_id IS NULL
              AND ${buildTokenMentionExistsSql('post', '$2')}
          ),
          directly_mentioned_comments AS (
            SELECT post.id, post.post_id, post.sender_address, post.created_at
            FROM posts post
            WHERE post.is_hidden = false
              AND post.created_at >= $1
              AND post.post_id IS NOT NULL
              AND ${buildTokenMentionExistsSql('post', '$2')}
          ),
          seed_posts AS (
            SELECT * FROM mentioned_root_posts
            UNION
            SELECT * FROM directly_mentioned_comments
          ),
          thread_comments AS (
            SELECT comment.id, comment.post_id, comment.sender_address, comment.created_at
            FROM posts comment
            INNER JOIN seed_posts seed ON comment.post_id = seed.id
            WHERE comment.is_hidden = false
              AND comment.created_at >= $1
            UNION
            SELECT child.id, child.post_id, child.sender_address, child.created_at
            FROM posts child
            INNER JOIN thread_comments thread ON child.post_id = thread.id
            WHERE child.is_hidden = false
              AND child.created_at >= $1
          ),
          matched_posts AS (
            SELECT * FROM seed_posts
            UNION
            SELECT * FROM thread_comments
          ),
          matched_post_ids AS (
            SELECT DISTINCT id FROM matched_posts
          ),
          social_activity AS (
            SELECT created_at FROM matched_posts
            UNION ALL
            SELECT tip.created_at
            FROM tips tip
            INNER JOIN posts tipped_post ON tipped_post.id = tip.post_id
            WHERE tip.post_id IN (SELECT id FROM matched_post_ids)
              AND tip.sender_address != tipped_post.sender_address
              AND tip.created_at >= $1
            UNION ALL
            SELECT reads.date::timestamp
            FROM post_reads_daily reads
            WHERE reads.post_id IN (SELECT id FROM matched_post_ids)
              AND reads.date >= $3::date
          )
          SELECT
            (SELECT COUNT(*) FROM mentioned_root_posts) AS mention_posts,
            (SELECT COUNT(*) FROM matched_posts WHERE post_id IS NOT NULL) AS mention_comments,
            (SELECT COUNT(DISTINCT sender_address) FROM matched_posts) AS unique_authors,
            (
              SELECT COUNT(*)
              FROM tips tip
              INNER JOIN posts tipped_post ON tipped_post.id = tip.post_id
              WHERE tip.post_id IN (SELECT id FROM matched_post_ids)
                AND tip.sender_address != tipped_post.sender_address
                AND tip.created_at >= $1
            ) AS tips_count,
            (
              SELECT COALESCE(SUM(CAST(NULLIF(tip.amount, '') AS DECIMAL)), 0)
              FROM tips tip
              INNER JOIN posts tipped_post ON tipped_post.id = tip.post_id
              WHERE tip.post_id IN (SELECT id FROM matched_post_ids)
                AND tip.sender_address != tipped_post.sender_address
                AND tip.created_at >= $1
            ) AS tips_amount_ae,
            (
              SELECT COALESCE(SUM(reads.reads), 0)
              FROM post_reads_daily reads
              WHERE reads.post_id IN (SELECT id FROM matched_post_ids)
                AND reads.date >= $3::date
            ) AS reads,
            (SELECT MAX(created_at) FROM social_activity) AS last_social_activity_at
        `,
        [windowStart, normalizedSymbol, windowStartDate],
      ),
    ]);

    const trade = tradeRows[0] ?? {};
    const social = socialRows[0] ?? {};

    const tradingSignals = {
      active_wallets: this.buildTrendingMetric(
        Number(trade.active_wallets || 0),
        TRENDING_SCORE_CONFIG.CAPS.activeWallets,
      ),
      buy_count: this.buildTrendingMetric(
        Number(trade.buy_count || 0),
        TRENDING_SCORE_CONFIG.CAPS.buyCount,
      ),
      sell_count: this.buildTrendingMetric(
        Number(trade.sell_count || 0),
        TRENDING_SCORE_CONFIG.CAPS.sellCount,
      ),
      volume_ae: this.buildTrendingMetric(
        Number(trade.volume_ae || 0),
        TRENDING_SCORE_CONFIG.CAPS.volumeAe,
      ),
    };

    const socialSignals = {
      mention_posts: this.buildTrendingMetric(
        Number(social.mention_posts || 0),
        TRENDING_SCORE_CONFIG.CAPS.mentionPosts,
      ),
      mention_comments: this.buildTrendingMetric(
        Number(social.mention_comments || 0),
        TRENDING_SCORE_CONFIG.CAPS.mentionComments,
      ),
      unique_authors: this.buildTrendingMetric(
        Number(social.unique_authors || 0),
        TRENDING_SCORE_CONFIG.CAPS.uniqueAuthors,
      ),
      tips_count: this.buildTrendingMetric(
        Number(social.tips_count || 0),
        TRENDING_SCORE_CONFIG.CAPS.tipsCount,
      ),
      tips_amount_ae: this.buildTrendingMetric(
        Number(social.tips_amount_ae || 0),
        TRENDING_SCORE_CONFIG.CAPS.tipsAmountAe,
      ),
      reads: this.buildTrendingMetric(
        Number(social.reads || 0),
        TRENDING_SCORE_CONFIG.CAPS.reads,
      ),
    };

    const tradingScore =
      TRENDING_SCORE_CONFIG.TRADING_WEIGHTS.activeWallets *
        tradingSignals.active_wallets.normalized +
      TRENDING_SCORE_CONFIG.TRADING_WEIGHTS.buyCount *
        tradingSignals.buy_count.normalized +
      TRENDING_SCORE_CONFIG.TRADING_WEIGHTS.sellCount *
        tradingSignals.sell_count.normalized +
      TRENDING_SCORE_CONFIG.TRADING_WEIGHTS.volumeAe *
        tradingSignals.volume_ae.normalized;

    const socialScore =
      TRENDING_SCORE_CONFIG.SOCIAL_WEIGHTS.mentionPosts *
        socialSignals.mention_posts.normalized +
      TRENDING_SCORE_CONFIG.SOCIAL_WEIGHTS.mentionComments *
        socialSignals.mention_comments.normalized +
      TRENDING_SCORE_CONFIG.SOCIAL_WEIGHTS.uniqueAuthors *
        socialSignals.unique_authors.normalized +
      TRENDING_SCORE_CONFIG.SOCIAL_WEIGHTS.tipsCount *
        socialSignals.tips_count.normalized +
      TRENDING_SCORE_CONFIG.SOCIAL_WEIGHTS.tipsAmountAe *
        socialSignals.tips_amount_ae.normalized +
      TRENDING_SCORE_CONFIG.SOCIAL_WEIGHTS.reads *
        socialSignals.reads.normalized;

    const preDecayScore =
      TRENDING_SCORE_CONFIG.GROUP_WEIGHTS.trading * tradingScore +
      TRENDING_SCORE_CONFIG.GROUP_WEIGHTS.social * socialScore;

    const lastTradeAt = trade.last_trade_at
      ? new Date(trade.last_trade_at)
      : null;
    const lastSocialActivityAt = social.last_social_activity_at
      ? new Date(social.last_social_activity_at)
      : null;
    const lastActivityAt = this.getLatestDate(lastTradeAt, lastSocialActivityAt);
    const ageHoursSinceLastActivity = lastActivityAt
      ? Math.max(
          0,
          (Date.now() - lastActivityAt.getTime()) / (1000 * 60 * 60),
        )
      : TRENDING_SCORE_CONFIG.WINDOW_HOURS;

    const decayMultiplier =
      preDecayScore > 0
        ? 1 /
          Math.pow(
            1 +
              ageHoursSinceLastActivity /
                TRENDING_SCORE_CONFIG.DECAY.biasHours,
            TRENDING_SCORE_CONFIG.DECAY.gravity,
          )
        : 0;

    const finalScore = Number((preDecayScore * decayMultiplier).toFixed(6));

    return {
      window_hours: TRENDING_SCORE_CONFIG.WINDOW_HOURS,
      last_activity_at: lastActivityAt,
      last_trade_at: lastTradeAt,
      last_social_activity_at: lastSocialActivityAt,
      age_hours_since_last_activity: Number(
        ageHoursSinceLastActivity.toFixed(4),
      ),
      decay_multiplier: Number(decayMultiplier.toFixed(6)),
      trading_signals: tradingSignals,
      social_signals: socialSignals,
      component_scores: {
        trading: Number(tradingScore.toFixed(6)),
        social: Number(socialScore.toFixed(6)),
        pre_decay: Number(preDecayScore.toFixed(6)),
      },
      trending_score: {
        formula:
          '((trading_weight * trading_score) + (social_weight * social_score)) * freshness_decay',
        result: finalScore,
        pre_decay: Number(preDecayScore.toFixed(6)),
      },
    };
  }

  /**
   * Calculate and update trending score for a single token
   */
  async updateTokenTrendingScore(token: Token): Promise<{
    metrics: TrendingMetrics;
    token: Token;
  }> {
    if (!token) {
      throw new NotFoundException('Token not found');
    }

    try {
      const metrics = await this.calculateTokenTrendingMetrics(token);
      const safeScore = Number.isFinite(metrics.trending_score.result)
        ? metrics.trending_score.result
        : 0;

      // Update the token's trending score in the database
      await this.tokensRepository.update(token.sale_address, {
        trending_score: safeScore,
        trending_score_update_at: new Date(),
      });

      return {
        metrics,
        token: {
          ...token,
          trending_score: safeScore,
          trending_score_update_at: new Date(),
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to update trending score for token ${token.sale_address}`,
        error,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Calculate and update trending scores for multiple tokens
   */
  async updateMultipleTokensTrendingScores(tokens: Token[]): Promise<void> {
    if (!tokens.length) {
      return;
    }

    const concurrency = Math.max(
      1,
      TRENDING_SCORE_CONFIG.MAX_CONCURRENT_UPDATES,
    );

    for (let index = 0; index < tokens.length; index += concurrency) {
      const batch = tokens.slice(index, index + concurrency);
      await Promise.allSettled(
        batch.map((token) => this.updateTokenTrendingScore(token)),
      );
    }
  }

  async deleteTokensWhereDaoAddressIsNull(): Promise<void> {
    await this.tokensRepository.delete({
      dao_address: IsNull(),
    });
  }
}
