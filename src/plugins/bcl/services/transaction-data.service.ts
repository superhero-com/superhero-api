import { Injectable } from '@nestjs/common';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { IPriceDto } from '@/tokens/dto/price.dto';
import { toAe } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';
import moment from 'moment';

export interface ParsedTransactionData {
  amount: BigNumber;
  volume: BigNumber;
  total_supply: BigNumber;
  protocol_reward: BigNumber;
  _should_revalidate: boolean;
}

export interface PriceCalculations {
  _unit_price: BigNumber;
  _previous_buy_price: BigNumber;
  _buy_price: BigNumber;
  _market_cap: BigNumber;
}

export interface TransactionData {
  sale_address: string;
  tx_type: string;
  tx_hash: string;
  block_height: number;
  address: string;
  volume: BigNumber;
  protocol_reward: BigNumber;
  amount: IPriceDto;
  unit_price: IPriceDto;
  previous_buy_price: IPriceDto;
  buy_price: IPriceDto;
  total_supply: BigNumber;
  market_cap: IPriceDto;
  created_at: Date;
  verified: boolean;
}

@Injectable()
export class TransactionDataService {
  constructor(private readonly aePricingService: AePricingService) {}

  /**
   * Calculate prices from decoded transaction and parsed data
   * @param decodedTx - Decoded transaction with events
   * @param parsedData - Parsed transaction data
   * @returns Calculated prices
   */
  calculatePrices(
    decodedTx: Tx,
    parsedData: ParsedTransactionData,
  ): PriceCalculations {
    const decodedData = decodedTx.raw?.decodedData;
    const priceChangeData = decodedData?.find(
      (data) => data.name === 'PriceChange',
    );

    const _unit_price = parsedData.amount.div(parsedData.volume);
    const _previous_buy_price = !!priceChangeData?.args
      ? new BigNumber(toAe(priceChangeData.args[0]))
      : _unit_price;
    const _buy_price = !!priceChangeData?.args
      ? new BigNumber(toAe(priceChangeData.args[1]))
      : _unit_price;
    const _market_cap = _buy_price.times(parsedData.total_supply);

    return {
      _unit_price,
      _previous_buy_price,
      _buy_price,
      _market_cap,
    };
  }

  /**
   * Prepare transaction data with price calculations and external API calls
   * @param saleAddress - Sale address
   * @param decodedTx - Decoded transaction
   * @param parsedData - Parsed transaction data
   * @param priceCalculations - Calculated prices
   * @returns Complete transaction data ready for persistence
   */
  async prepareTransactionData(
    saleAddress: string,
    decodedTx: Tx,
    parsedData: ParsedTransactionData,
    priceCalculations: PriceCalculations,
  ): Promise<TransactionData> {
    // Get price data from external API (outside transaction scope)
    const [amount, unit_price, previous_buy_price, buy_price, market_cap] =
      await Promise.all([
        this.aePricingService.getPriceData(parsedData.amount),
        this.aePricingService.getPriceData(priceCalculations._unit_price),
        this.aePricingService.getPriceData(
          priceCalculations._previous_buy_price,
        ),
        this.aePricingService.getPriceData(priceCalculations._buy_price),
        this.aePricingService.getPriceData(priceCalculations._market_cap),
      ]);

    const txData: TransactionData = {
      sale_address: saleAddress,
      tx_type: decodedTx.function,
      tx_hash: decodedTx.hash,
      block_height: decodedTx.block_height,
      address: decodedTx.caller_id,
      volume: parsedData.volume,
      protocol_reward: parsedData.protocol_reward,
      amount,
      unit_price,
      previous_buy_price,
      buy_price,
      total_supply: parsedData.total_supply,
      market_cap,
      created_at: moment(parseInt(decodedTx.micro_time, 10)).toDate(),
      verified:
        !parsedData._should_revalidate &&
        moment().diff(moment(parseInt(decodedTx.micro_time, 10)), 'hours') >= 5,
    };

    return txData;
  }
}
