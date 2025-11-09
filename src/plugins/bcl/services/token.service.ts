import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { Encoded } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PULL_TOKEN_INFO_QUEUE } from '@/tokens/queues/constants';

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
    private readonly tokensService: TokensService,
    private readonly communityFactoryService: CommunityFactoryService,
    private readonly tokenWebsocketGateway: TokenWebsocketGateway,
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

    if (!address.startsWith('ct_')) {
      // For non-contract addresses, delegate to TokensService
      return this.tokensService.getToken(address);
    }

    // Create token from address (delegate to TokensService for complex logic)
    return this.tokensService.getToken(address);
  }

  /**
   * Find token by address (or name/symbol)
   */
  async findByAddress(
    address: string,
    withoutRank = false,
    manager?: EntityManager,
  ): Promise<Token | null> {
    const repository = manager?.getRepository(Token) || this.tokensRepository;
    const token = await repository
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

    const [rankResult] = await repository.query(rankedQuery);
    return {
      ...token,
      rank: rankResult?.rank,
    } as Token & { rank: number };
  }

  /**
   * Create token from raw transaction (Tx entity)
   * Works directly with Tx entity (no conversion needed)
   */
  async createTokenFromRawTransaction(
    tx: Tx,
    manager?: EntityManager,
  ): Promise<Token | null> {
    const rawTx = tx.raw || {};
    const factory = await this.communityFactoryService.getCurrentFactory();
    const repository = manager?.getRepository(Token) || this.tokensRepository;

    if (
      tx.function !== 'create_community' ||
      rawTx.return_type === 'revert' ||
      !rawTx.return?.value?.length ||
      rawTx.return.value.length < 2
    ) {
      return null;
    }

    if (
      // If it's not supported collection, skip
      !rawTx.arguments?.[0]?.value ||
      !Object.keys(factory.collections).includes(rawTx.arguments[0].value)
    ) {
      return null;
    }

    const daoAddress = rawTx.return.value[0]?.value;
    const saleAddress = rawTx.return.value[1]?.value;
    const tokenName = rawTx.arguments?.[1]?.value;

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
      token = await this.findByAddress(tokenExists.sale_address, false, manager);
    } else {
      token = await repository.save(tokenData);
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
   * Sync token price from live data
   */
  async syncTokenPrice(
    token: Token,
    manager?: EntityManager,
  ): Promise<void> {
    try {
      const data = await this.getTokenLivePrice(token);
      const repository = manager?.getRepository(Token) || this.tokensRepository;

      await repository.update(token.sale_address, data as any);

      // re-fetch token and broadcast outside transaction
      if (!manager) {
        this.tokenWebsocketGateway?.handleTokenUpdated({
          sale_address: token.sale_address,
          data,
        });
      }
    } catch (error) {
      this.logger.error(`Failed to sync token price for ${token.sale_address}`, error);
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
    return this.findByAddress(token.sale_address, false, manager);
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

