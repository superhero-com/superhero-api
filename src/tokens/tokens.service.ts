import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Repository } from 'typeorm';

import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { InjectQueue } from '@nestjs/bull';
import { CommunityFactory, initTokenSale, TokenSale } from 'bctsl-sdk';
import BigNumber from 'bignumber.js';
import { Queue } from 'bull';
import moment from 'moment';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { fetchJson } from '@/utils/common';
import { ICommunityFactorySchema, ITransaction } from '@/utils/types';
import { ACTIVE_NETWORK } from '@/configs';
import { SYNC_TRANSACTIONS_QUEUE } from '@/transactions/queues/constants';
import { Token } from './entities/token.entity';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './queues/constants';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { CommunityFactoryService } from '@/ae/community-factory.service';

type TokenContracts = {
  instance?: TokenSale;
  tokenContractInstance?: ContractWithMethods<ContractMethodsBase>;
  token?: Token;
};

@Injectable()
export class TokensService {
  contracts: Record<Encoded.ContractAddress, TokenContracts> = {};
  totalTokens = 0;
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    private aeSdkService: AeSdkService,

    private tokenWebsocketGateway: TokenWebsocketGateway,

    private aePricingService: AePricingService,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,
    @InjectQueue(SYNC_TRANSACTIONS_QUEUE)
    private readonly syncTransactionsQueue: Queue,

    private communityFactoryService: CommunityFactoryService,
  ) {
    this.init();
  }

  factoryContract: CommunityFactory;
  async init() {
    console.log('--------------------------------');
    console.log('init tokens service');
    console.log('--------------------------------');
    const factory = await this.communityFactoryService.getCurrentFactory();
    this.factoryContract = await this.communityFactoryService.loadFactory(
      factory.address,
    );
    void this.loadFactoryTokens(factory);
  }

  async loadFactoryTokens(factory: ICommunityFactorySchema) {
    const communities = await this.loadCreatedCommunityFromMdw(
      `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?contract=${factory.address}&limit=50`,
      factory,
    );

    const tokens = communities.sort((a, b) => {
      if (!a.total_supply || !b.total_supply) return 0;
      return b.total_supply.minus(a.total_supply).toNumber();
    });
    for (const token of tokens) {
      const liveTokenData = await this.getTokeLivePrice(token);
      await this.tokensRepository.update(token.id, liveTokenData);
      this.contracts[token.sale_address].token = token;
      void this.syncTokenHoldersQueue.add(
        {
          saleAddress: token.sale_address,
        },
        {
          jobId: `syncTokenHolders-${token.sale_address}`,
          removeOnComplete: true,
        },
      );
      void this.syncTransactionsQueue.add({
        saleAddress: token.sale_address,
      });
    }
  }

  async loadCreatedCommunityFromMdw(
    url: string,
    factory: ICommunityFactorySchema,
    tokens: Token[] = [],
  ): Promise<Token[]> {
    let result;
    try {
      result = await fetchJson(url);
    } catch (error) {
      console.log('error::', error);
      return tokens;
    }

    for (const transaction of result.data) {
      if (transaction.tx.function !== 'create_community') {
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

      const tokenExists = await this.findByAddress(saleAddress);
      if (tokenExists) {
        continue;
      }
      const tokenName = transaction?.tx?.arguments?.[1]?.value;

      const decodedData = this.factoryContract.contract.$decodeEvents(
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
        tokenData.total_supply = new BigNumber(tokenDataResponse?.event_supply);
        tokenData.holders_count = tokenDataResponse?.holders;
      }

      const token = await this.tokensRepository.save(tokenData);
      tokens.push(token);
      this.contracts[saleAddress] = {
        token,
      };
    }

    if (result.next) {
      return await this.loadCreatedCommunityFromMdw(
        `${ACTIVE_NETWORK.middlewareUrl}${result.next}`,
        factory,
        tokens,
      );
    }
    return tokens;
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

  async findByAddress(address: string): Promise<Token | null> {
    const token = await this.tokensRepository
      .createQueryBuilder('token')
      .where('token.address = :address', { address })
      .orWhere('token.sale_address = :address', { address })
      .orWhere('token.name = :address', { address })
      .getOne();

    if (!token) {
      return null;
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

  async getToken(
    address: string,
    shouldSyncTransactions = true,
  ): Promise<Token> {
    const existingToken = await this.findByAddress(address);

    if (existingToken) {
      return existingToken;
    }

    return this.createToken(
      address as Encoded.ContractAddress,
      shouldSyncTransactions,
    );
  }

  async createToken(
    saleAddress: Encoded.ContractAddress,
    shouldSyncTransactions = true,
  ): Promise<Token | null> {
    const { instance } = await this.getTokenContractsBySaleAddress(saleAddress);

    if (!instance) {
      return null;
    }

    const [tokenMetaInfo] = await Promise.all([
      instance.metaInfo().catch(() => {
        return { token: {} };
      }),
    ]);

    const tokenData = {
      sale_address: saleAddress,
      ...(tokenMetaInfo?.token || {}),
    };
    // prevent duplicate tokens
    const existingToken = await this.findByAddress(saleAddress);
    if (existingToken) {
      return existingToken;
    }

    const newToken = await this.tokensRepository.save(tokenData);
    const factoryAddress = await this.updateTokenFactoryAddress(newToken);

    if (!factoryAddress) {
      await this.tokensRepository.delete(newToken.id);
      return null;
    }
    await this.syncTokenPrice(newToken);
    // refresh token token info
    // TODO: should refresh token info
    void this.syncTokenHoldersQueue.add(
      {
        saleAddress,
      },
      {
        jobId: `syncTokenHolders-${saleAddress}`,
        removeOnComplete: true,
      },
    );
    if (shouldSyncTransactions) {
      void this.syncTransactionsQueue.add(
        {
          saleAddress,
        },
        {
          jobId: `syncTokenTransactions-${saleAddress}`,
        },
      );
    }
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
      `${ACTIVE_NETWORK.middlewareUrl}/v2/txs/${contractInfo.source_tx_hash}`,
    );

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

    try {
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
    } catch (error) {
      return undefined;
    }
  }

  private async getTokeLivePrice(token: Token) {
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
      factory_address: transaction.tx.contractId,
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
        totalItems: null,
        totalPages: null,
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
      )
      SELECT * FROM ranked_tokens WHERE id IN (${tokenIds.join(',')})
    `;

    const result = await this.tokensRepository.query(rankedQuery);
    return new Map(result.map((token) => [token.id, token.rank]));
  }
}
