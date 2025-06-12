import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { IsNull, Repository } from 'typeorm';

import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { ACTIVE_NETWORK } from '@/configs';
import { fetchJson } from '@/utils/common';
import { ICommunityFactorySchema, ITransaction } from '@/utils/types';
import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { CommunityFactory, initTokenSale, TokenSale } from 'bctsl-sdk';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import { Token } from './entities/token.entity';
import { TokenWebsocketGateway } from './token-websocket.gateway';

type TokenContracts = {
  instance?: TokenSale;
  tokenContractInstance?: ContractWithMethods<ContractMethodsBase>;
  token?: Token;
};

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  contracts: Record<Encoded.ContractAddress, TokenContracts> = {};
  totalTokens = 0;
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    private aeSdkService: AeSdkService,

    private tokenWebsocketGateway: TokenWebsocketGateway,

    private aePricingService: AePricingService,

    private communityFactoryService: CommunityFactoryService,
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

  async loadCreatedCommunityFromMdw(
    url: string,
    factory: ICommunityFactorySchema,
    saleAddresses: string[] = [],
  ): Promise<string[]> {
    this.logger.log('loadCreatedCommunityFromMdw->url::', url);
    let result: any;
    try {
      result = await fetchJson(url);
    } catch (error) {
      this.logger.error('loadCreatedCommunityFromMdw->error::', error);
      return saleAddresses;
    }

    if (!result?.data?.length) {
      this.logger.log('loadCreatedCommunityFromMdw->no data::', url);
      for (const transaction of result.data) {
        if (
          transaction.tx.function !== 'create_community' ||
          transaction?.tx?.return_type === 'revert'
        ) {
          continue;
        }
        if (
          !Object.keys(factory.collections).includes(
            transaction.tx.arguments[0].value,
          )
        ) {
          continue;
        }
        // handled reverted transactions
        if (
          !transaction?.tx?.return?.value?.length ||
          transaction.tx.return.value.length < 2
        ) {
          continue;
        }
        const daoAddress = transaction?.tx?.return?.value[0]?.value;
        const saleAddress = transaction?.tx?.return?.value[1]?.value;
        saleAddresses.push(saleAddress);

        const tokenExists = await this.findByAddress(saleAddress);
        if (tokenExists?.id) {
          continue;
        }
        const tokenName = transaction?.tx?.arguments?.[1]?.value;

        const decodedData = this.factoryContract?.contract?.$decodeEvents(
          transaction?.tx?.log,
        );
        const tokenData = {
          total_supply: new BigNumber(0),
          holders_count: 0,
          address: null,
          dao_address: daoAddress,
          sale_address: saleAddress,
          factory_address: factory.address,
          creator_address: transaction?.tx?.caller_id,
          created_at: moment(transaction?.micro_time).toDate(),
          name: tokenName,
          symbol: tokenName,
        };

        const fungibleToken = decodedData?.find(
          (event) =>
            event.contract.name === 'FungibleTokenFull' &&
            event.contract.address !==
              'ct_dsa6octVEHPcm7wRszK6VAjPp1FTqMWa7sBFdxQ9jBT35j6VW',
        );
        if (fungibleToken) {
          tokenData.address = fungibleToken.contract.address;
          const tokenDataResponse = await fetchJson(
            `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${tokenData.address}`,
          );
          tokenData.total_supply = new BigNumber(
            tokenDataResponse?.event_supply,
          );
          tokenData.holders_count = tokenDataResponse?.holders;
        }

        const token = await this.tokensRepository.save(tokenData);
        this.contracts[saleAddress] = {
          token,
        };
      }
    }

    if (result.next) {
      return await this.loadCreatedCommunityFromMdw(
        `${ACTIVE_NETWORK.middlewareUrl}${result.next}`,
        factory,
        saleAddresses,
      );
    }
    return saleAddresses;
  }

  async loadTokenContractAndUpdateMintAddress(token: Token) {
    const contract = await this.getTokenContractsBySaleAddress(
      token.sale_address as Encoded.ContractAddress,
    );
    const priceData = await this.getTokeLivePrice(token);

    this.tokensRepository.update(token.id, {
      address: contract?.tokenContractInstance?.$options.address,
      ...priceData,
    });
  }

  findAll(): Promise<Token[]> {
    return this.tokensRepository.find();
  }

  async update(token: Token, data): Promise<Token> {
    await this.tokensRepository.update(token.id, data);
    return this.findByAddress(token.sale_address);
  }

  async findById(id: number): Promise<Token | null> {
    return this.tokensRepository.findOneBy({ id });
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
          id,
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
      WHERE id = ${token.id}
    `;

    const [rankResult] = await this.tokensRepository.query(rankedQuery);
    return {
      ...token,
      rank: rankResult?.rank,
    } as Token & { rank: number };
  }

  findOne(id: number): Promise<Token | null> {
    return this.tokensRepository.findOneBy({ id });
  }

  async syncTokenPrice(token: Token): Promise<void> {
    try {
      const data = await this.getTokeLivePrice(token);

      await this.tokensRepository.update(token.id, data as any);
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

    return this.createToken(address as Encoded.ContractAddress);
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
      });
    }

    const newToken = await this.tokensRepository.save(tokenData);
    const factoryAddress = await this.updateTokenFactoryAddress(newToken);

    if (!factoryAddress) {
      await this.tokensRepository.delete(newToken.id);
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
    // 1. fetch factory create tx
    const contractInfo = await fetchJson(
      `${ACTIVE_NETWORK.middlewareUrl}/v2/contracts/${token.sale_address}`,
    );

    const response = await fetchJson(
      `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions/${contractInfo.source_tx_hash}`,
    );

    if (!response?.tx?.contract_id) {
      this.logger.error(
        'updateTokenFactoryAddress->error::',
        response,
        contractInfo,
      );
      return null;
    }

    const factory_address = response?.tx?.contract_id;
    await this.updateTokenMetaDataFromCreateTx(
      token,
      camelcaseKeysDeep(response),
    );

    return factory_address as Encoded.ContractAddress;
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
    };

    return this.contracts[saleAddress];
  }

  async getTokeLivePrice(token: Token) {
    const contract = await this.getTokenContracts(token);
    if (!contract) {
      return {};
    }
    const { instance, tokenContractInstance } = contract;

    const [total_supply, price, sell_price, metaInfo] = await Promise.all([
      tokenContractInstance
        .total_supply?.()
        .then((res) => new BigNumber(res.decodedResult))
        .catch(() => new BigNumber('0')),
      instance
        .price(1)
        .then((res: string) => new BigNumber(res || '0'))
        .catch(() => new BigNumber('0')),
      instance
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        .sellReturn?.('1' as string)
        .then((res: string) => new BigNumber(res || '0'))
        .catch(() => new BigNumber('0')),
      instance.metaInfo().catch(() => {
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
      creator_address: transaction?.tx?.callerId,
      created_at: moment(transaction?.microTime).toDate(),
    };
    if (transaction?.tx.arguments?.[0]?.value) {
      tokenData['collection'] = transaction?.tx.arguments[0].value;
    }
    await this.tokensRepository.update(token.id, tokenData);

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
      finalSubQuery = finalSubQuery.replace(`:${key}`, `'${value}'`);
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
      INNER JOIN filtered_tokens ON all_ranked_tokens.id = filtered_tokens.id
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

  async getTokenRanks(tokenIds: number[]): Promise<Map<number, number>> {
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
      SELECT * FROM ranked_tokens WHERE id IN (${tokenIds.join(',')})
    `;

    const result = await this.tokensRepository.query(rankedQuery);
    return new Map(result.map((token) => [token.id, token.rank]));
  }
}
