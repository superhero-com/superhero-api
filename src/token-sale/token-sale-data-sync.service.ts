import { Injectable } from '@nestjs/common';
import camelcaseKeysDeep from 'camelcase-keys-deep';

import { Encoded, toAe } from '@aeternity/aepp-sdk';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { CoinGeckoService } from 'src/ae/coin-gecko.service';
import { ACTIVE_NETWORK, NETWORK_ID_TESTNET } from 'src/ae/utils/networks';
import { IToken, ITransaction } from 'src/ae/utils/types';
import { TokensService } from 'src/tokens/tokens.service';
import { RoomFactory, initRoomFactory } from 'token-sale-sdk';
import { Token } from 'src/tokens/entities/token.entity';
import { fetchJson } from 'src/ae/utils/common';
import { TX_FUNCTIONS } from 'src/ae/utils/constants';
import { InjectRepository } from '@nestjs/typeorm';
import { TokenHistory } from 'src/tokens/entities/token-history.entity';
import { Repository } from 'typeorm';
import BigNumber from 'bignumber.js';
import moment from 'moment';

type RoomToken = Partial<IToken> & {
  symbol: string;
  saleAddress: Encoded.ContractAddress;
  factoryAddress: Encoded.ContractAddress;
};

export interface ITokenSaleFactory {
  factory: RoomFactory;
  address: Encoded.ContractAddress;
  bondingCurveAddress: Encoded.ContractAddress;
  tokens: RoomToken[];
}

@Injectable()
export class TokenSaleDataSyncService {
  tokenSaleFactories: Record<Encoded.ContractAddress, ITokenSaleFactory> = {};

  activeNetworkId = NETWORK_ID_TESTNET;

  initRoomFactory: typeof initRoomFactory;

  constructor(
    private tokensService: TokensService,
    private aeSdkService: AeSdkService,
    private coinGeckoService: CoinGeckoService,

    @InjectRepository(TokenHistory)
    private tokenHistoriesRepository: Repository<TokenHistory>,
  ) {}

  async syncTokenHistory(token: Token) {
    console.log('======================');
    console.log('syncTokenHistory::', token);
    console.log('======================');
    const query: Record<string, string | number> = {
      direction: 'forward',
      limit: 100, // TODO: pagination, lazy load next results
      type: 'contract_call',
      contract: token.sale_address,
    };
    // convery query to query string
    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');

    fetchJson(`${ACTIVE_NETWORK.middlewareUrl}/v2/txs?${queryString}`).then(
      (response) => {
        response.data
          .map((item: ITransaction) => camelcaseKeysDeep(item))
          .forEach((item: ITransaction) =>
            this.saveTokenTransaction(token, item),
          );
      },
    );
  }

  async saveTokenTransaction(token: Token, transaction: ITransaction) {
    if (transaction.tx.function !== TX_FUNCTIONS.buy) {
      return;
    }

    const transactionDate = moment(transaction.microTime).format(
      'YYYY-MM-DD HH:mm:ss',
    );
    // Prevent duplicate entries
    const exists = await this.tokenHistoriesRepository
      .createQueryBuilder('token_history')
      .where('token_history.sale_address = :sale_address', {
        sale_address: token.sale_address,
      })
      .where('token_history.created_at = :created_at', {
        created_at: transactionDate,
      });
    if (exists) {
      return;
    }

    console.log('======================');
    console.log('saveTokenTransaction::', token, transaction);
    console.log('======================');

    this.tokenHistoriesRepository.save({
      token,
      sale_address: token.sale_address,
      price: {
        ae: this.calculateAePrice(transaction).toString() as any,
      },
      sell_price: {
        ae: this.calculateAePrice(transaction).toString() as any,
      },
      market_cap: {
        ae: 0,
      },
      created_at: moment(transactionDate).toDate(),
      // sell_price: transaction.tx.params.sell_price,
      // market_cap: transaction.tx.params.market_cap,
      // volume: transaction.tx.params.volume,
      // total_supply: transaction.tx.params.total_supply,
    });
  }

  calculateAePrice(transaction: ITransaction): BigNumber {
    try {
      if (transaction.tx.function === TX_FUNCTIONS.buy) {
        const totalBoughTokens = new BigNumber(
          toAe(transaction.tx.arguments[0].value.toString()),
        );
        const spentAeAmount = new BigNumber(
          toAe(transaction.tx.amount.toString()),
        );

        // get the price of 1 token in ae
        return spentAeAmount.div(totalBoughTokens);
      }

      if (transaction.tx.function === TX_FUNCTIONS.sell) {
        const totalBoughTokens = new BigNumber(
          toAe(transaction.tx.arguments[0].value.toString()),
        );
        const spentAeAmount = new BigNumber(
          toAe(transaction.tx.return?.value.toString()),
        );

        // get the price of 1 token in ae
        return spentAeAmount.div(totalBoughTokens);
      }

      if (transaction.tx.function === TX_FUNCTIONS.create_community) {
        const totalBoughTokens = new BigNumber(
          toAe(
            transaction.tx.arguments.find((arg) => arg.type === 'int')?.value,
          ),
        );
        const spentAeAmount = new BigNumber(
          toAe(transaction.tx.amount.toString()),
        );
        return spentAeAmount.div(totalBoughTokens);
      }
    } catch (e) {
      console.error(e);
    }

    return new BigNumber(0);
  }
}
