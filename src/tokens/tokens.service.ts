import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Token } from './entities/token.entity';
import { Encoded } from '@aeternity/aepp-sdk';
import { initTokenSale } from 'token-gating-sdk';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { TokenGatingService } from 'src/ae/token-gating.service';
import { fetchJson } from 'src/ae/utils/common';
import { ACTIVE_NETWORK } from 'src/ae/utils/networks';

@Injectable()
export class TokensService {
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    private aeSdkService: AeSdkService,

    private tokenWebsocketGateway: TokenWebsocketGateway,

    private tokenGatingService: TokenGatingService,
  ) {
    //
  }

  findAll(): Promise<Token[]> {
    return this.tokensRepository.find();
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
    const { instance } = await initTokenSale(
      this.aeSdkService.sdk,
      saleAddress as Encoded.ContractAddress,
    ).catch((error) => {
      return { instance: null };
    });

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

    const newToken = await this.tokensRepository.save(tokenData);
    await this.updateTokenCategory(newToken);
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

  async updateTokenCategory(token: Token): Promise<string> {
    if (token.category) {
      return token.category;
    }

    try {
      const factoryAddress = await this.updateTokenFactoryAddress(token);
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

    await this.tokensRepository.update(token.id, {
      factory_address: response?.tx?.contract_id,
    });

    return response?.tx?.contract_id as Encoded.ContractAddress;
  }

  detectTokenCategoryFromName(token: Token): string {
    const name = token.name.toLowerCase();
    // if name is only numbers return number
    if (/^\d+$/.test(name)) {
      return 'number';
    }
    return 'word';
  }
}
