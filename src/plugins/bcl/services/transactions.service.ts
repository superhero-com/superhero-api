import { Injectable, Logger } from '@nestjs/common';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { BCL_FUNCTIONS } from '@/configs';
import { Encoded, toAe } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly communityFactoryService: CommunityFactoryService,
  ) {}

  /**
   * Decode transaction events from a Tx entity
   */
  async decodeTxEvents(
    token: Token,
    tx: Tx,
    retries = 0,
  ): Promise<Tx> {
    try {
      const factory = await this.communityFactoryService.loadFactory(
        token.factory_address as Encoded.ContractAddress,
      );
      const decodedData = factory.contract.$decodeEvents(tx.raw?.log || []);

      return {
        ...tx,
        raw: {
          ...tx.raw,
          decodedData,
        },
      };
    } catch (error: any) {
      if (retries < 3) {
        return this.decodeTxEvents(token, tx, retries + 1);
      }
      this.logger.error(
        `decodeTxEvents->error:: retry ${retries}/3`,
        error,
        error.stack,
      );
      return tx;
    }
  }

  /**
   * Parse transaction data from a Tx entity
   */
  async parseTransactionData(tx: Tx): Promise<{
    volume: BigNumber;
    amount: BigNumber;
    total_supply: BigNumber;
    protocol_reward: BigNumber;
    _should_revalidate: boolean;
  }> {
    const decodedData = tx.raw?.decodedData;
    let volume = new BigNumber(0);
    let amount = new BigNumber(0);
    let total_supply = new BigNumber(0);
    let protocol_reward = new BigNumber(0);

    if (!decodedData || decodedData.length == 0) {
      return {
        volume,
        amount,
        total_supply,
        protocol_reward,
        _should_revalidate: true,
      };
    }

    if (tx.function === BCL_FUNCTIONS.buy) {
      const mints = decodedData.filter((data) => data.name === 'Mint');
      protocol_reward = new BigNumber(toAe(mints[0].args[1]));
      volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
      amount = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Buy').args[0]),
      );
      total_supply = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Buy').args[2]),
      ).plus(volume);
    }

    if (tx.function === BCL_FUNCTIONS.create_community) {
      if (decodedData.find((data) => data.name === 'PriceChange')) {
        const mints = decodedData.filter((data) => data.name === 'Mint');
        protocol_reward = new BigNumber(toAe(mints[0].args[1]));
        volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
        amount = new BigNumber(
          toAe(decodedData.find((data) => data.name === 'Buy').args[0]),
        );
        total_supply = new BigNumber(
          toAe(decodedData.find((data) => data.name === 'Buy').args[2]),
        ).plus(volume);
      }
    }

    if (tx.function === BCL_FUNCTIONS.sell) {
      volume = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Burn').args[1]),
      );
      amount = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Sell').args[0]),
      );
      total_supply = new BigNumber(
        toAe(decodedData.find((data) => data.name === 'Sell').args[1]),
      ).minus(volume);
    }

    return {
      volume,
      amount,
      total_supply,
      protocol_reward,
      _should_revalidate: false,
    };
  }

  /**
   * Checks if the given token is part of a supported collection.
   */
  async isTokenSupportedCollection(token: Token): Promise<boolean> {
    const factory = await this.communityFactoryService.getCurrentFactory();

    if (
      token.factory_address !== factory.address
      && !Object.keys(factory.collections).includes(token.collection)
    ) {
      return false;
    }

    return true;
  }

}

