import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Encoded } from '@aeternity/aepp-sdk';
import ContractWithMethods, {
  ContractMethodsBase,
} from '@aeternity/aepp-sdk/es/contract/Contract';
import BigNumber from 'bignumber.js';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { CoinGeckoService } from 'src/ae/coin-gecko.service';
import { TokenGatingService } from 'src/ae/token-gating.service';
import { fetchJson } from 'src/ae/utils/common';
import { ACTIVE_NETWORK } from 'src/ae/utils/networks';
import { initTokenSale, TokenSale } from 'token-gating-sdk';
import { Token } from './entities/token.entity';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { ROOM_FACTORY_CONTRACTS } from 'src/ae/utils/constants';

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

    private tokenGatingService: TokenGatingService,

    private coinGeckoService: CoinGeckoService,
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
    const data = await this.getTokeLivePrice(token);

    await this.tokensRepository.update(token.id, data as any);
    // update token ranks

    // re-fetch token
    this.tokenWebsocketGateway?.handleTokenUpdated({
      sale_address: token.sale_address,
      data,
    });
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
    await this.updateTokenCategory(newToken, factoryAddress);
    await this.syncTokenPrice(newToken);
    // TODO: should refresh token info
    await this.updateTokenInitialRank(newToken);
    return this.findOne(newToken.id);
  }

  async updateTokenInitialRank(token: Token): Promise<number> {
    const tokensCount = await this.tokensRepository.count();
    // TODO: add initial category_rank
    await this.tokensRepository.update(token.id, {
      rank: tokensCount + 1,
    });
    return tokensCount + 1;
  }

  async updateTokenCategory(token: Token, factoryAddress): Promise<string> {
    if (token.category) {
      return token.category;
    }

    try {
      const communityFactory =
        await this.tokenGatingService.loadTokenGatingFactory(factoryAddress);

      const communityManagementContract =
        await communityFactory.getCommunityManagementContract(
          token.sale_address as Encoded.ContractAddress,
        );

      const metaInfo: Record<string, string> = await communityManagementContract
        .meta_info()
        .then((r) => {
          const obj: Record<string, string> = {};
          for (const [key, value] of r.decodedResult) {
            obj[key] = value;
          }
          return obj;
        })
        .catch(() => {
          return {};
        });

      if (!metaInfo?.category) {
        const category = this.detectTokenCategoryFromName(token);
        await this.tokensRepository.update(token.id, {
          category,
        });
        return category;
      }

      await this.tokensRepository.update(token.id, {
        category: metaInfo.category,
      });
      return metaInfo.category;
    } catch (error) {
      const category = this.detectTokenCategoryFromName(token);
      await this.tokensRepository.update(token.id, {
        category,
      });
      return category;
    }
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
    // check if factory address is supported
    // if (
    //   !ROOM_FACTORY_CONTRACTS[ACTIVE_NETWORK.networkId].some(
    //     (f) => f.contractId === factory_address,
    //   )
    // ) {
    //   return null;
    // }

    await this.tokensRepository.update(token.id, {
      factory_address: factory_address,
    });

    return factory_address as Encoded.ContractAddress;
  }

  detectTokenCategoryFromName(token: Token): string {
    const name = token.name.toLowerCase();
    // if name is only numbers return number
    if (/^\d+$/.test(name)) {
      return 'number';
    }
    return 'word';
  }

  async getTokenContracts(token: Token) {
    return this.getTokenContractsBySaleAddress(
      token.sale_address as Encoded.ContractAddress,
    );
  }

  async getTokenContractsBySaleAddress(
    saleAddress: Encoded.ContractAddress,
  ): Promise<TokenContracts> {
    if (this.contracts[saleAddress]) {
      console.log('RETURNING CACHED CONTRACTS');
      return this.contracts[saleAddress];
    }
    const { instance } = await initTokenSale(
      this.aeSdkService.sdk,
      saleAddress,
    );
    const tokenContractInstance = await instance?.tokenContractInstance();

    this.contracts[saleAddress] = {
      instance,
      tokenContractInstance,
    };

    return this.contracts[saleAddress];
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
      this.coinGeckoService.getPriceData(price),
      this.coinGeckoService.getPriceData(sell_price),
      this.coinGeckoService.getPriceData(market_cap),
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
}
