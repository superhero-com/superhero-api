import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { Repository } from 'typeorm';

import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import { InjectQueue } from '@nestjs/bull';
import { initTokenSale, TokenSale } from 'bctsl-sdk';
import BigNumber from 'bignumber.js';
import { Queue } from 'bull';
import moment from 'moment';
import { AePricingService } from 'src/ae-pricing/ae-pricing.service';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { fetchJson } from 'src/utils/common';
import { ITransaction } from 'src/utils/types';
import { ACTIVE_NETWORK } from 'src/configs';
import { SYNC_TRANSACTIONS_QUEUE } from 'src/transactions/queues/constants';
import { Token } from './entities/token.entity';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './queues/constants';
import { TokenWebsocketGateway } from './token-websocket.gateway';

type TokenContracts = {
  instance: TokenSale;
  tokenContractInstance: ContractWithMethods<ContractMethodsBase>;
};

@Injectable()
export class TokensService {
  contracts: Record<Encoded.ContractAddress, TokenContracts> = {};
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
  ) {
    //
  }

  findAll(): Promise<Token[]> {
    return this.tokensRepository.find();
  }

  async update(token: Token, data): Promise<Token> {
    await this.tokensRepository.update(token.id, data);
    return this.findOne(token.id);
  }

  searchForToken(address: string): Promise<Token | null> {
    return this.tokensRepository
      .createQueryBuilder('token')
      .where('token.address = :address', { address })
      .orWhere('token.sale_address = :address', { address })
      .orWhere('token.name = :address', { address })
      .getOne();
  }

  findByAddress(address: string): Promise<Token | null> {
    return this.tokensRepository
      .createQueryBuilder('token')
      .where('token.address = :address', { address })
      .orWhere('token.sale_address = :address', { address })
      .getOne();
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
    await this.updateTokenInitialRank(newToken);
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
    return this.findOne(newToken.id);
  }

  async updateTokenInitialRank(token: Token): Promise<number> {
    const tokensCount = await this.tokensRepository.count();
    // TODO: add initial collection_rank
    await this.tokensRepository.update(token.id, {
      rank: tokensCount + 1,
    });
    return tokensCount + 1;
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
  ): Promise<TokenContracts> {
    const { instance } = await initTokenSale(
      this.aeSdkService.sdk,
      saleAddress,
    );
    const tokenContractInstance = await instance?.tokenContractInstance();

    return {
      instance,
      tokenContractInstance,
    };
  }

  private async getTokeLivePrice(token: Token) {
    const { instance, tokenContractInstance } =
      await this.getTokenContracts(token);

    const [total_supply] = await Promise.all([
      tokenContractInstance
        .total_supply?.()
        .then((res) => new BigNumber(res.decodedResult))
        .catch(() => new BigNumber('0')),
    ]);
    const [price, sell_price, metaInfo] = await Promise.all([
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

    const [price_data, sell_price_data, market_cap_data] = await Promise.all([
      this.aePricingService.getPriceData(price),
      this.aePricingService.getPriceData(sell_price),
      this.aePricingService.getPriceData(market_cap),
    ]);

    const dao_balance = await this.aeSdkService.sdk.getBalance(
      metaInfo?.beneficiary,
    );

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
      created_at: moment(transaction?.tx?.microTime).toDate(),
    };
    if (transaction?.tx.arguments?.[0]?.value) {
      tokenData['collection'] = transaction?.tx.arguments[0].value;
    }
    await this.tokensRepository.update(token.id, tokenData);

    return transaction.tx.contractId;
  }
}
