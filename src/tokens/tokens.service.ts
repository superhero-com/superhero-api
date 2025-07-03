import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { In, IsNull, Repository } from 'typeorm';

import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { ACTIVE_NETWORK, TRENDING_SCORE_CONFIG } from '@/configs';
import { fetchJson } from '@/utils/common';
import { ITransaction } from '@/utils/types';
import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { InjectQueue } from '@nestjs/bull';
import { CommunityFactory, initTokenSale, TokenSale } from 'bctsl-sdk';
import BigNumber from 'bignumber.js';
import { Queue } from 'bull';
import moment from 'moment';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { PULL_TOKEN_INFO_QUEUE } from './queues/constants';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { Transaction } from '@/transactions/entities/transaction.entity';

type TokenContracts = {
  instance?: TokenSale;
  tokenContractInstance?: ContractWithMethods<ContractMethodsBase>;
  token?: Token;
  lastUsedAt?: number;
};

interface TrendingMetrics {
  uniqueTransactions24h: number;
  investmentVolume24h: number;
  lifetimeMinutes: number;
}

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  contracts: Record<Encoded.ContractAddress, TokenContracts> = {};
  totalTokens = 0;
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHolder)
    private tokenHoldersRepository: Repository<TokenHolder>,

    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,

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
      SELECT rank
      FROM ranked_tokens
      WHERE sale_address = '${token.sale_address}'
    `;

    const [rankResult] = await this.tokensRepository.query(rankedQuery);
    return {
      ...token,
      rank: rankResult?.rank,
    } as Token & { rank: number };
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

  async getTokenAex9Address(token: Token): Promise<string> {
    if (token.address) {
      return token.address;
    }
    const { instance } = await this.getTokenContractsBySaleAddress(
      token.sale_address as Encoded.ContractAddress,
    );
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
    const { instance } = await this.getTokenContractsBySaleAddress(saleAddress);

    if (!instance) {
      return null;
    }

    const [tokenMetaInfo] = await Promise.all([
      instance.metaInfo().catch(() => {
        return { token: {} };
      }),
    ]);

    const tokenData: any = {
      sale_address: saleAddress,
      ...(tokenMetaInfo?.token || {}),
    };
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

    const newToken = await this.tokensRepository.save(tokenData);
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
    const { instance } = await initTokenSale(
      this.aeSdkService.sdk,
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
        .catch((error) => {
          this.logger.error(
            `getTokeLivePrice->error:: price`,
            token.sale_address,
            error,
            error.stack,
          );
          return new BigNumber(0);
        }),
      instance
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        .sellReturn?.('1' as string)
        .then((res: string) => new BigNumber(res || '0'))
        .catch((error) => {
          this.logger.error(
            `getTokeLivePrice->error:: sell_price`,
            token.sale_address,
            error,
            error.stack,
          );
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
        this.aeSdkService.sdk.getBalance(metaInfo?.beneficiary),
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
        const arrayValues = value.map((v) => `'${v}'`).join(',');
        finalSubQuery = finalSubQuery.replace(`:...${key}`, arrayValues);
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

    // Create a new query that includes the rank
    const rankedQuery = `
      WITH all_ranked_tokens AS (
        SELECT 
          *,
          CAST(RANK() OVER (
            ORDER BY 
              CASE WHEN market_cap = 0 THEN 1 ELSE 0 END,
              market_cap DESC,
              created_at ASC
          ) AS INTEGER) as rank
        FROM token
        WHERE unlisted = false
      ),
      filtered_tokens AS (
        ${finalSubQuery}
      )
      SELECT all_ranked_tokens.*
      FROM all_ranked_tokens
      INNER JOIN filtered_tokens ON all_ranked_tokens.sale_address = filtered_tokens.sale_address
      ORDER BY all_ranked_tokens.${orderBy} ${orderDirection}
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

    let token;
    let isNewToken = false;
    // TODO: should only update if the data is different
    if (tokenExists?.sale_address) {
      await this.tokensRepository.update(tokenExists.sale_address, tokenData);
      token = await this.findByAddress(tokenExists.sale_address);
    } else {
      token = await this.tokensRepository.save(tokenData);
      isNewToken = true;
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
    const aex9Address =
      token?.address || (await this.getTokenAex9Address(token));

    const totalHolders = await this._loadHoldersData(token, aex9Address);
    if (totalHolders.length > 0) {
      await this.tokenHoldersRepository.delete({
        aex9_address: aex9Address,
      });
      await this.tokenHoldersRepository.insert(totalHolders);
    }
    await this.tokensRepository.update(token.sale_address, {
      holders_count: totalHolders.length,
    });
  }

  async _loadHoldersData(token: Token, aex9Address: string) {
    const _holders = await this._loadHoldersFromContract(token, aex9Address);
    if (_holders.length > 0) {
      return _holders;
    }
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
    totalHolders = [],
  ) {
    try {
      const response = await fetchJson(url);
      if (!response.data) {
        this.logger.error(
          `SyncTokenHoldersQueue:failed to load data from url::${url}`,
        );
        this.logger.error(`SyncTokenHoldersQueue:response::`, response);
        return totalHolders;
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
        );
      }

      return totalHolders;
    } catch (error: any) {
      this.logger.error(`SyncTokenHoldersQueue->error`, error, error.stack);
      return totalHolders;
    }
  }

  async _loadHoldersFromContract(token: Token, aex9Address: string) {
    try {
      const { tokenContractInstance } =
        await this.getTokenContractsBySaleAddress(
          token.sale_address as Encoded.ContractAddress,
        );
      const holderBalances = await tokenContractInstance.balances();
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
      this.logger.error(
        `SyncTokenHoldersQueue->_loadHoldersFromContract:failed to load holders from contract`,
        error,
        error.stack,
      );
      return [];
    }
  }

  /**
   * Calculate 24-hour trending metrics for a token
   */
  async calculateTokenTrendingMetrics(token: Token): Promise<TrendingMetrics> {
    const twentyFourHoursAgo = moment().subtract(
      TRENDING_SCORE_CONFIG.TIME_WINDOW_HOURS,
      'hours',
    );

    // Calculate unique transactions in 24h
    const uniqueTransactionsResult = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .select('COUNT(DISTINCT transactions.address)', 'count')
      .where('transactions.sale_address = :sale_address', {
        sale_address: token.sale_address,
      })
      .andWhere('transactions.created_at >= :start_date', {
        start_date: twentyFourHoursAgo.toDate(),
      })
      .getRawOne();

    // Calculate investment volume in AE in 24h (only buy transactions)
    const investmentVolumeResult = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .select(
        "COALESCE(SUM(CAST(NULLIF(transactions.amount->>'ae', 'NaN') AS DECIMAL)), 0)",
        'volume',
      )
      .where('transactions.sale_address = :sale_address', {
        sale_address: token.sale_address,
      })
      .andWhere('transactions.created_at >= :start_date', {
        start_date: twentyFourHoursAgo.toDate(),
      })
      .andWhere('transactions.tx_type = :tx_type', {
        tx_type: 'buy',
      })
      .getRawOne();

    // Calculate lifetime minutes (within last 24 hours, max 1440)
    const tokenCreatedAt = moment(token.created_at);
    const now = moment();
    const lifetimeMinutes = Math.min(
      now.diff(tokenCreatedAt, 'minutes'),
      TRENDING_SCORE_CONFIG.MAX_LIFETIME_MINUTES,
    );

    return {
      uniqueTransactions24h: parseInt(
        uniqueTransactionsResult?.count || '0',
        10,
      ),
      investmentVolume24h: parseFloat(investmentVolumeResult?.volume || '0'),
      lifetimeMinutes: Math.max(lifetimeMinutes, 1), // Prevent division by zero
    };
  }

  /**
   * Calculate trending score for a single token
   */
  async calculateTokenTrendingScore(token: Token): Promise<number> {
    const metrics = await this.calculateTokenTrendingMetrics(token);

    // If no activity, return 0
    if (
      metrics.uniqueTransactions24h === 0 &&
      metrics.investmentVolume24h === 0
    ) {
      return 0;
    }

    // Simple score without normalization (for single token)
    const volumePerMinute =
      metrics.investmentVolume24h / metrics.lifetimeMinutes;

    return (
      TRENDING_SCORE_CONFIG.TRANSACTION_WEIGHT * metrics.uniqueTransactions24h +
      TRENDING_SCORE_CONFIG.VOLUME_WEIGHT * volumePerMinute
    );
  }

  /**
   * Calculate normalized trending scores for all tokens
   */
  async calculateAllTokensTrendingScores(): Promise<TrendingMetrics[]> {
    const factory = await this.communityFactoryService.getCurrentFactory();

    // Get all tokens
    const tokens = await this.tokensRepository.find({
      where: {
        factory_address: factory.address,
        unlisted: false,
      },
    });

    // Calculate raw metrics for all tokens
    const tokenMetrics = await Promise.all(
      tokens.map(async (token) => ({
        token,
        metrics: await this.calculateTokenTrendingMetrics(token),
      })),
    );

    // Filter out tokens with no activity
    const activeTokens = tokenMetrics.filter(
      ({ metrics }) =>
        metrics.uniqueTransactions24h > 0 || metrics.investmentVolume24h > 0,
    );

    if (activeTokens.length === 0) {
      return [];
    }

    // Calculate volume per minute for each token
    const tokensWithVolumePerMinute = activeTokens.map(
      ({ token, metrics }) => ({
        token,
        metrics,
        volumePerMinute: metrics.investmentVolume24h / metrics.lifetimeMinutes,
      }),
    );

    // Find min/max values for normalization
    const transactions = tokensWithVolumePerMinute.map(
      ({ metrics }) => metrics.uniqueTransactions24h,
    );
    const volumePerMinutes = tokensWithVolumePerMinute.map(
      ({ volumePerMinute }) => volumePerMinute,
    );

    const minTransactions = Math.min(...transactions);
    const maxTransactions = Math.max(...transactions);
    const minVolumePerMinute = Math.min(...volumePerMinutes);
    const maxVolumePerMinute = Math.max(...volumePerMinutes);

    // Normalize and calculate final scores
    return tokensWithVolumePerMinute.map(({ metrics, volumePerMinute }) => ({
      // Min-Max normalization (0-1 range)
      uniqueTransactions24h:
        maxTransactions > minTransactions
          ? (metrics.uniqueTransactions24h - minTransactions) /
            (maxTransactions - minTransactions)
          : 0,
      investmentVolume24h:
        maxVolumePerMinute > minVolumePerMinute
          ? (volumePerMinute - minVolumePerMinute) /
            (maxVolumePerMinute - minVolumePerMinute)
          : 0,
      lifetimeMinutes: Math.max(metrics.lifetimeMinutes, 1), // Prevent division by zero
    }));
  }

  /**
   * Calculate and update trending score for a single token
   */
  async updateTokenTrendingScore(token: Token): Promise<void> {
    try {
      const metrics = await this.calculateTokenTrendingMetrics(token);

      // Simple score calculation without normalization
      // Using raw values with reasonable scaling
      const volumePerMinute =
        metrics.investmentVolume24h / metrics.lifetimeMinutes;

      // Scale the metrics to reasonable values
      const scaledTransactions = metrics.uniqueTransactions24h * 0.1; // Scale down transactions
      const scaledVolumePerMinute = volumePerMinute * 10; // Scale up volume per minute

      const trendingScore =
        TRENDING_SCORE_CONFIG.TRANSACTION_WEIGHT * scaledTransactions +
        TRENDING_SCORE_CONFIG.VOLUME_WEIGHT * scaledVolumePerMinute;

      // Update the token's trending score in the database
      await this.tokensRepository.update(token.sale_address, {
        trending_score: Math.max(0, trendingScore), // Ensure non-negative
        trending_score_update_at: new Date(),
      });

      // this.logger.debug(
      //   `Updated trending score for token ${token.symbol}: ${trendingScore}`,
      //   {
      //     saleAddress: token.sale_address,
      //     metrics,
      //     trendingScore,
      //   },
      // );
    } catch (error) {
      this.logger.error(
        `Failed to update trending score for token ${token.sale_address}`,
        error,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Calculate and update trending scores for multiple tokens
   */
  async updateMultipleTokensTrendingScores(tokens: Token[]): Promise<void> {
    const updatePromises = tokens.map((token) =>
      this.updateTokenTrendingScore(token),
    );
    await Promise.allSettled(updatePromises);
  }

  /**
   * Calculate and update trending scores for all tokens
   */
  async updateAllTokensTrendingScores(): Promise<void> {
    const factory = await this.communityFactoryService.getCurrentFactory();

    const tokens = await this.tokensRepository.find({
      where: {
        factory_address: factory.address,
        unlisted: false,
      },
    });

    this.logger.log(`Updating trending scores for ${tokens.length} tokens`);
    await this.updateMultipleTokensTrendingScores(tokens);
    this.logger.log(`Finished updating trending scores for all tokens`);
  }
}
