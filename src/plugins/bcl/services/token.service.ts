import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { Encoded } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PULL_TOKEN_INFO_QUEUE } from '@/tokens/queues/constants';

type PriceRefresh = {
  current: Promise<void>;
  next: Promise<void> | null;
};

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly priceRefreshes = new Map<string, PriceRefresh>();

  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
    private readonly tokensService: TokensService,
    private readonly communityFactoryService: CommunityFactoryService,
    private readonly aePricingService: AePricingService,
    @InjectQueue(PULL_TOKEN_INFO_QUEUE)
    private readonly pullTokenInfoQueue: Queue,
  ) {}

  /**
   * Get token by address, creates it if it doesn't exist
   */
  async getToken(address: string): Promise<Token> {
    const existingToken = await this.findByAddress(address);

    if (existingToken) {
      return existingToken;
    }

    // Handles both a name/symbol lookup and lazy creation from a contract address.
    return this.tokensService.getToken(address, true);
  }

  /**
   * Find token by address (or name/symbol)
   */
  async findByAddress(
    address: string,
    manager?: EntityManager,
  ): Promise<Token | null> {
    const repository = manager?.getRepository(Token) || this.tokensRepository;
    // No rank here: this used to recompute RANK() OVER (...) across every
    // token of the factory on each call -- 135ms against 63k tokens, on the
    // indexer's hot path, for a value no caller here reads.
    return repository
      .createQueryBuilder('token')
      .where('token.address = :address', { address })
      .orWhere('token.sale_address = :address', { address })
      .orWhere('token.name = :address', { address })
      .orWhere('token.symbol = :address', { address })
      .getOne();
  }

  /**
   * Create token from raw transaction (Tx entity)
   * Works directly with Tx entity (no conversion needed)
   */
  async createTokenFromRawTransaction(
    tx: Tx,
    manager?: EntityManager,
  ): Promise<Token | null> {
    const factory = await this.communityFactoryService.getCurrentFactory();
    const repository = manager?.getRepository(Token) || this.tokensRepository;

    if (
      tx.function !== 'create_community' ||
      tx.raw.return_type === 'revert' ||
      !tx.raw.return?.value?.length ||
      tx.raw.return.value.length < 2
    ) {
      return null;
    }

    if (
      // If it's not supported collection, skip
      !tx.raw.arguments?.[0]?.value ||
      !Object.keys(factory.collections).includes(tx.raw.arguments[0].value)
    ) {
      return null;
    }

    const daoAddress = tx.raw.return.value[0]?.value;
    const saleAddress = tx.raw.return.value[1]?.value;
    const tokenName = tx.raw.arguments?.[1]?.value;

    let tokenExists = await this.findByNameOrSymbol(tokenName, manager);

    if (
      !!tokenExists?.sale_address &&
      tokenExists.sale_address !== saleAddress
    ) {
      // delete token
      await repository.delete(tokenExists.sale_address);
      tokenExists = undefined;
    }

    const tokenData: Partial<Token> = {
      total_supply: new BigNumber(0),
      holders_count: 0,
      address: null,
      ...(tokenExists || {}),
      dao_address: daoAddress,
      sale_address: saleAddress,
      factory_address: factory.address,
      collection: tx?.raw?.arguments?.[0]?.value,
      creator_address: tx.caller_id || tokenExists?.creator_address,
      created_at: moment(parseInt(tx.micro_time, 10)).toDate(),
      name: tokenName,
      symbol: tokenName,
      create_tx_hash: tx.hash,
    };

    let token: Token;
    let isNewToken = false;
    // TODO: should only update if the data is different
    if (tokenExists?.sale_address) {
      await repository.update(tokenExists.sale_address, tokenData);
      token = await this.findByAddress(tokenExists.sale_address, manager);
    } else {
      // Use upsert to handle race conditions where token might be created concurrently.
      // Do not use skipUpdateIfNoValuesChanged because Token has json columns and
      // PostgreSQL cannot compare json values with "=" during that optimization.
      await repository.upsert(tokenData, {
        conflictPaths: ['sale_address'],
      });
      token = await this.findByAddress(saleAddress, manager);
      isNewToken = true;
    }

    // Queue job outside transaction
    if (!manager) {
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
    }

    return token;
  }

  /**
   * Find token by name or symbol
   */
  private async findByNameOrSymbol(
    name: string,
    manager?: EntityManager,
  ): Promise<Token | null> {
    const repository = manager?.getRepository(Token) || this.tokensRepository;
    return repository
      .createQueryBuilder('token')
      .where('token.name = :name', { name })
      .orWhere('token.symbol = :name', { name })
      .getOne();
  }

  /**
   * Refresh the token's live price, outside any transaction. A request made
   * while a refresh of the same token runs is served by one follow-up run
   * that starts after it, so the last write reads chain state from after the
   * last committed trade. Never rejects.
   */
  refreshTokenPrice(token: Token): Promise<void> {
    const key = token.sale_address;
    const inFlight = this.priceRefreshes.get(key);
    if (inFlight) {
      inFlight.next ??= inFlight.current.then(() => this.syncTokenPrice(token));
      return inFlight.next;
    }

    const entry: PriceRefresh = {
      current: this.syncTokenPrice(token),
      next: null,
    };
    this.priceRefreshes.set(key, entry);
    this.advancePriceRefresh(key, entry);
    return entry.current;
  }

  private advancePriceRefresh(key: string, entry: PriceRefresh): void {
    // Relies on syncTokenPrice never rejecting; a rejection would leave the
    // entry in place and every later request for the token unserved.
    void entry.current.then(() => {
      if (entry.next) {
        entry.current = entry.next;
        entry.next = null;
        this.advancePriceRefresh(key, entry);
      } else {
        this.priceRefreshes.delete(key);
      }
    });
  }

  /**
   * Sends no token-updated broadcast: the live path never did, and it goes to
   * every connected client.
   */
  private async syncTokenPrice(token: Token): Promise<void> {
    try {
      const data = await this.getTokenLivePrice(token);
      if (!data || Object.keys(data).length === 0) return;

      const updatePayload = Object.fromEntries(
        Object.entries(data ?? {}).filter(([, value]) => value !== undefined),
      );

      if (!Object.keys(updatePayload).length) {
        this.logger.debug(
          `Skipping token price sync for ${token.sale_address}: no values to update`,
        );
        return;
      }

      await this.tokensRepository.update(
        token.sale_address,
        updatePayload as any,
      );
    } catch (error) {
      this.logger.error(
        `Failed to sync token price for ${token.sale_address}`,
        error,
      );
    }
  }

  /**
   * Get live token price data
   */
  private async getTokenLivePrice(token: Token): Promise<
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
    // Delegate to TokensService for complex contract interaction logic
    return this.tokensService.getTokeLivePrice(token);
  }

  /**
   * Update token trending score
   */
  async updateTokenTrendingScore(token: Token): Promise<{
    metrics: any;
    token: Token;
  }> {
    // Delegate to TokensService for complex trending score calculation
    return this.tokensService.updateTokenTrendingScore(token);
  }

  /**
   * Update token and return updated token
   */
  async update(
    token: Token,
    data: Partial<Token>,
    manager?: EntityManager,
  ): Promise<Token> {
    const repository = manager?.getRepository(Token) || this.tokensRepository;
    await repository.update(token.sale_address, data);
    return this.findByAddress(token.sale_address, manager);
  }

  /**
   * Update token metadata from create_community transaction
   * Works directly with Tx entity (no conversion needed)
   */
  async updateTokenMetaDataFromCreateTx(
    token: Token,
    tx: Tx,
    manager?: EntityManager,
  ): Promise<Encoded.ContractAddress> {
    const tokenData: Partial<Token> = {
      factory_address: tx.contract_id,
      creator_address: tx.caller_id,
      created_at: moment(parseInt(tx.micro_time, 10)).toDate(),
    };

    // Extract collection from transaction arguments
    if (tx.raw?.arguments?.[0]?.value) {
      tokenData.collection = tx.raw.arguments[0].value;
    }

    const repository = manager?.getRepository(Token) || this.tokensRepository;
    await repository.update(token.sale_address, tokenData);

    return tx.contract_id as Encoded.ContractAddress;
  }
}
