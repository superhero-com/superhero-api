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
  private readonly BUY_TOPIC =
    '103347481884921461187458933603797704361973189016747204637339841427224784760666';
  private readonly SELL_TOPIC =
    '23104635772480053538972224151762463181492989144154121566848232077119925570281';
  private readonly PRICE_CHANGE_TOPIC =
    '3577134775049335318224940963029268892731434609492265317583808375263764302639';
  private readonly MINT_TOPIC =
    '97248968993606906149864095761415446114204891017168990930824289305879066770211';
  private readonly BURN_TOPIC =
    '59519329313588602299792785325724171247065768738621522936987157301332531057158';

  constructor(
    private readonly communityFactoryService: CommunityFactoryService,
  ) {}

  /**
   * Decode transaction events from a Tx entity
   */
  async decodeTxEvents(token: Token, tx: Tx, retries = 0): Promise<Tx> {
    try {
      const factory = await this.communityFactoryService.loadFactory(
        token.factory_address as Encoded.ContractAddress,
      );
      let decodedData = factory.contract.$decodeEvents(tx.raw?.log || [], {
        omitUnknown: true,
      });

      if (!decodedData?.length) {
        decodedData = await this.buildFallbackDecodedData(tx);
        if (decodedData.length) {
          this.logger.warn(
            `Using raw.log fallback decoder for transaction ${tx.hash}`,
          );
        }
      }

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

  private async buildFallbackDecodedData(tx: Tx): Promise<any[]> {
    const logs = Array.isArray(tx.raw?.log) ? tx.raw.log : [];
    if (tx.function === BCL_FUNCTIONS.sell) {
      const sellLog = logs.find((log) => log?.topics?.[0] === this.SELL_TOPIC);
      const burnLog = logs.find((log) => log?.topics?.[0] === this.BURN_TOPIC);
      const priceChangeLog = logs.find(
        (log) => log?.topics?.[0] === this.PRICE_CHANGE_TOPIC,
      );

      const amountRaw = sellLog?.topics?.[1]?.toString();
      const previousSupplyRaw = sellLog?.topics?.[2]?.toString();
      const volumeRaw = burnLog?.topics?.[2]?.toString();
      const previousBuyPriceRaw = priceChangeLog?.topics?.[1]?.toString();
      const buyPriceRaw = priceChangeLog?.topics?.[2]?.toString();

      if (!amountRaw || !previousSupplyRaw || !volumeRaw) {
        return [];
      }

      const decodedData = [
        {
          name: 'Sell',
          args: [amountRaw, previousSupplyRaw],
        },
        {
          name: 'Burn',
          args: [null, volumeRaw],
        },
      ];

      if (previousBuyPriceRaw && buyPriceRaw) {
        decodedData.push({
          name: 'PriceChange',
          args: [previousBuyPriceRaw, buyPriceRaw],
        });
      }

      return decodedData;
    }

    if (
      ![BCL_FUNCTIONS.buy, BCL_FUNCTIONS.create_community].includes(
        tx.function as typeof BCL_FUNCTIONS.buy,
      )
    ) {
      return [];
    }

    const buyLog = logs.find((log) => log?.topics?.[0] === this.BUY_TOPIC);
    const priceChangeLog = logs.find(
      (log) => log?.topics?.[0] === this.PRICE_CHANGE_TOPIC,
    );

    if (!buyLog || !priceChangeLog) {
      return [];
    }

    const volumeArgumentIndex =
      tx.function === BCL_FUNCTIONS.create_community ? 2 : 0;
    const volumeRaw =
      tx.raw?.arguments?.[volumeArgumentIndex]?.value?.toString();
    const amountRaw = tx.raw?.amount?.toString();
    const previousSupplyRaw = buyLog?.topics?.[3]?.toString();
    const previousBuyPriceRaw = priceChangeLog?.topics?.[1]?.toString();
    const buyPriceRaw = priceChangeLog?.topics?.[2]?.toString();

    if (
      !volumeRaw ||
      !amountRaw ||
      !previousSupplyRaw ||
      !previousBuyPriceRaw ||
      !buyPriceRaw
    ) {
      return [];
    }

    const currentFactory = await this.communityFactoryService.getCurrentFactory();
    const protocolRewardMintLog = logs.find(
      (log) =>
        log?.topics?.[0] === this.MINT_TOPIC &&
        log?.address === currentFactory.bctsl_aex9_address,
    );
    const protocolRewardRaw = protocolRewardMintLog?.topics?.[2]?.toString();

    if (!protocolRewardRaw) {
      return [];
    }

    return [
      {
        name: 'Mint',
        args: [null, protocolRewardRaw],
      },
      {
        name: 'Buy',
        args: [amountRaw, null, previousSupplyRaw],
      },
      {
        name: 'PriceChange',
        args: [previousBuyPriceRaw, buyPriceRaw],
      },
      {
        name: 'Mint',
        args: [null, volumeRaw],
      },
    ];
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
      token.factory_address !== factory.address &&
      !Object.keys(factory.collections).includes(token.collection)
    ) {
      return false;
    }

    return true;
  }
}
