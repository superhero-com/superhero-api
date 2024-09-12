import { Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { CoinGeckoService } from 'src/ae/coin-gecko.service';
import { TokenHistory } from 'src/tokens/entities/token-history.entity';
import { TokenTransaction } from 'src/tokens/entities/token-transaction.entity';
import { Token } from 'src/tokens/entities/token.entity';
import { TokenWebsocketGateway } from 'src/tokens/token-websocket.gateway';
import { initTokenSale } from 'token-sale-sdk';
import { Repository } from 'typeorm';

@Injectable()
export class PriceHistoryService {
  constructor(
    private aeSdkService: AeSdkService,
    private coinGeckoService: CoinGeckoService,

    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHistory)
    private tokenHistoriesRepository: Repository<TokenHistory>,

    private tokenWebsocketGateway: TokenWebsocketGateway,
  ) {}

  async saveLivePrice(
    sale_address: Encoded.ContractAddress,
    volume: BigNumber = new BigNumber('0'),
  ) {
    const token = await this.getToken(sale_address);
    const data = await this.getLivePricingData(sale_address);

    await this.tokensRepository.update(token.id, data as any);
    this.tokenWebsocketGateway?.handleTokenUpdated({
      sale_address,
      data,
    });

    const history = await this.tokenHistoriesRepository.save({
      token: token,
      volume,
      ...data,
    } as any);

    this.tokenWebsocketGateway?.handleTokenHistory({
      sale_address,
      data: history,
    });
  }

  async saveTokenHistoryFromTransaction(
    transaction: TokenTransaction,
    token: Token,
  ) {
    const exists = await this.tokenHistoriesRepository
      .createQueryBuilder('token_history')
      .where('token_history.tx_hash = :tx_hash', {
        tx_hash: transaction.tx_hash,
      })
      .getExists();

    if (exists) {
      return;
    }

    this.tokenHistoriesRepository.save({
      token,
      ...transaction,
    } as any);
  }

  private async getLivePricingData(sale_address: Encoded.ContractAddress) {
    const { instance, tokenContractInstance } =
      await this.getTokenContracts(sale_address);

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
      sale_address,
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

  async getToken(sale_address: Encoded.ContractAddress) {
    return await this.tokensRepository.findOneBy({
      sale_address: sale_address,
    });
  }

  async getTokenContracts(sale_address: Encoded.ContractAddress) {
    const { instance } = await initTokenSale(
      this.aeSdkService.sdk,
      sale_address,
    );
    const tokenContractInstance = await instance?.tokenContractInstance();

    return {
      instance,
      tokenContractInstance,
    };
  }
}
