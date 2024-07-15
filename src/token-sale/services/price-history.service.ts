import { Encoded } from '@aeternity/aepp-sdk';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { CoinGeckoService } from 'src/ae/coin-gecko.service';
import { ITransaction } from 'src/ae/utils/types';
import { TokenHistory } from 'src/tokens/entities/token-history.entity';
import { Token } from 'src/tokens/entities/token.entity';
import { initTokenSale } from 'token-sale-sdk';
import { Repository } from 'typeorm';
import { TransactionService } from './transaction.service';

@Injectable()
export class PriceHistoryService {
  constructor(
    private aeSdkService: AeSdkService,
    private coinGeckoService: CoinGeckoService,
    private transactionService: TransactionService,

    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHistory)
    private tokenHistoriesRepository: Repository<TokenHistory>,
  ) {
    //
  }

  async saveLivePrice(sale_address: Encoded.ContractAddress) {
    const token = await this.getToken(sale_address);
    const tokenPriceData = await this.getLivePricingData(sale_address);

    await this.tokensRepository.update(token.id, tokenPriceData as any);
  }

  async savePriceHistoryFromTransaction(
    sale_address: Encoded.ContractAddress,
    transaction: ITransaction,
    shouldLiveFetchPrice = true,
  ) {
    const token = await this.getToken(sale_address);

    const transactionDate = moment(transaction.microTime).format(
      'YYYY-MM-DD HH:mm:ss',
    );
    // Prevent duplicate entries
    const exists = await this.tokenHistoriesRepository
      .createQueryBuilder('token_history')
      .where('token_history.tx_hash = :tx_hash', {
        tx_hash: transaction.hash,
      })
      .getExists();

    if (exists) {
      return;
    }

    const tokenPriceData = shouldLiveFetchPrice
      ? await this.getLivePricingData(sale_address)
      : await this.getPricingDataFromTransaction(transaction);

    if (shouldLiveFetchPrice) {
      await this.tokensRepository.update(token.id, tokenPriceData as any);
    }

    this.tokenHistoriesRepository.save({
      tx_hash: transaction.hash,
      token,
      sale_address: token.sale_address,
      created_at: moment(transactionDate).toDate(),
      ...tokenPriceData,
    } as any);

    if (transaction.tx.function === 'create_community') {
      await this.tokensRepository.update(token.id, {
        owner_address: transaction.tx.callerId,
      });
    }
  }

  private async getPricingDataFromTransaction(transaction: ITransaction) {
    const price = this.transactionService.calculateTxSpentAePrice(transaction);
    const volume = this.transactionService.calculateTxVolume(transaction);
    const amount = this.transactionService.getTxAmount(transaction);

    const [price_data, sell_price_data, amount_data] = await Promise.all([
      this.coinGeckoService.getPriceData(price),
      this.coinGeckoService.getPriceData(price),
      this.coinGeckoService.getPriceData(amount),
    ]);

    return {
      price,
      price_data,
      sell_price: price,
      sell_price_data,
      volume,
      account: transaction.tx.callerId,
      tx_type: transaction.tx.function,
      amount,
      amount_data,
      //   total_supply,
      //   market_cap,
      //   market_cap_data,
    };
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
    const [price, sell_price] = await Promise.all([
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
    ]);

    const market_cap = total_supply.multipliedBy(price);

    const [price_data, sell_price_data, market_cap_data] = await Promise.all([
      this.coinGeckoService.getPriceData(price),
      this.coinGeckoService.getPriceData(sell_price),
      this.coinGeckoService.getPriceData(market_cap),
    ]);

    return {
      sale_address,
      price,
      sell_price,
      sell_price_data,
      total_supply,
      price_data,
      market_cap,
      market_cap_data,
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
