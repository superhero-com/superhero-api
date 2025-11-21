import BigNumber from 'bignumber.js';

import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { Injectable, Logger } from '@nestjs/common';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection, SyncDirectionEnum } from '../plugin.interface';
import { BCL_CONTRACT } from './config/bcl.config';
import { TransactionProcessorService } from './services/transaction-processor.service';
import { BclTransactionPersistenceService } from './services/bcl-transaction-persistence.service';
import { BclTokenPersistenceService } from './services/bcl-token-persistence.service';

import { serializeBigInts } from '@/utils/common';
import CommunityFactoryACI from './contract/aci/CommunityFactory.aci.json';
import { toAe } from '@aeternity/aepp-sdk';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { DataSource } from 'typeorm';

@Injectable()
export class BclPluginSyncService extends BasePluginSyncService {
  readonly pluginName = 'bcl';
  protected readonly logger = new Logger(BclPluginSyncService.name);

  constructor(
    private readonly transactionProcessorService: TransactionProcessorService,
    private readonly tokenWebsocketGateway: TokenWebsocketGateway,
    private readonly aePricingService: AePricingService,
    private readonly bclTransactionPersistenceService: BclTransactionPersistenceService,
    private readonly bclTokenPersistenceService: BclTokenPersistenceService,
    aeSdkService: AeSdkService,
    private readonly dataSource: DataSource,
  ) {
    super(aeSdkService);
  }

  async processTransaction(
    rawTransaction: Tx,
    syncDirection: SyncDirection,
  ): Promise<void> {
    // TODO: remove this logic, only broadcast transaction to websocket if it's live
    try {
      // Delegate transaction processing to processor service
      // const result =
      //   await this.transactionProcessorService.processTransaction(
      //     rawTransaction,
      //     syncDirection,
      //   );

      // Save BCL transaction record if processing was successful
      const txData = rawTransaction.data?.bcl?.data;
      if (!txData) {
        this.logger.warn(`No BCL transaction data found for transaction ${rawTransaction.hash}`);
        return;
      }
      await this.bclTransactionPersistenceService.saveBclTransaction(
        rawTransaction,
        txData,
      );

      // Save BCL token record if this is a create_community transaction
      if (rawTransaction.function === BCL_CONTRACT.FUNCTIONS.create_community) {
        try {
          await this.bclTokenPersistenceService.saveBclToken(
            rawTransaction,
            txData,
          );
        } catch (error: any) {
          this.logger.error(
            `Failed to save BCL token for transaction ${rawTransaction.hash}`,
            error.stack,
          );
          // Don't throw - token save failure shouldn't block the main flow
        }
      }

      // Background operations outside transaction
      // if (result && result.isSupported && syncDirection === SyncDirectionEnum.Live) {
      //   // Broadcast transaction via WebSocket
      //   this.tokenWebsocketGateway?.handleTokenHistory({
      //     sale_address: result.txData.sale_address,
      //     data: result.txData,
      //     token: result.transactionToken,
      //   });
      // }
    } catch (error: any) {
      this.handleError(error, rawTransaction, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }


  async decodeLogs(tx: Tx): Promise<any | null> {
    if (!tx?.raw?.log) {
      return null;
    }

    try {
      const contract = await this.getContract(BCL_CONTRACT.contractAddress, CommunityFactoryACI);
      const decodedLogs = contract.$decodeEvents(tx.raw.log);

      return serializeBigInts(decodedLogs);
    } catch (error: any) {
      this.logger.error(
        `Failed to decode logs for transaction ${tx.hash}`,
        error.stack,
      );
      return null;
    }

  }

  async onUpdateComplete(): Promise<void> {
    // Materialized view refresh removed - BCL transactions and tokens are now saved directly to tables
  }

  async decodeData(tx: Tx): Promise<any | null> {
    const pluginLogs = tx.logs?.[this.pluginName];
    if (!pluginLogs?.data?.length) {
      return null;
    }
    const createCommunityLogs = pluginLogs.data.find((log: any) => log.name === 'CreateCommunity');
    const setOwnerLogs = pluginLogs.data.find((log: any) => log.name === 'SetOwner');

    let volume = new BigNumber(0);
    let _amount = new BigNumber(0);
    let total_supply = new BigNumber(0);
    let protocol_reward = new BigNumber(0);
    let dao_balance = '0';

    if (tx.function === BCL_CONTRACT.FUNCTIONS.buy) {
      const mints = pluginLogs.data.filter((data) => data.name === 'Mint');
      protocol_reward = new BigNumber(toAe(mints[0].args[1]));
      volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
      _amount = new BigNumber(
        toAe(pluginLogs.data.find((data) => data.name === 'Buy').args[0]),
      );
      total_supply = new BigNumber(
        toAe(pluginLogs.data.find((data) => data.name === 'Buy').args[2]),
      ).plus(volume);
      dao_balance = pluginLogs.data.find((data) => data.name === 'Buy').args[1];
    }
    if (tx.function === BCL_CONTRACT.FUNCTIONS.create_community) {
      if (pluginLogs.data.find((data) => data.name === 'PriceChange')) {
        const mints = pluginLogs.data.filter((data) => data.name === 'Mint');
        protocol_reward = new BigNumber(toAe(mints[0].args[1]));
        volume = new BigNumber(toAe(mints[mints.length - 1].args[1]));
        _amount = new BigNumber(
          toAe(pluginLogs.data.find((data) => data.name === 'Buy').args[0]),
        );
        total_supply = new BigNumber(
          toAe(pluginLogs.data.find((data) => data.name === 'Buy').args[2]),
        ).plus(volume);
        dao_balance = pluginLogs.data.find((data) => data.name === 'Buy').args[1];
      }
    }
    if (tx.function === BCL_CONTRACT.FUNCTIONS.sell) {
      volume = new BigNumber(
        toAe(pluginLogs.data.find((data) => data.name === 'Burn').args[1]),
      );
      _amount = new BigNumber(
        toAe(pluginLogs.data.find((data) => data.name === 'Sell').args[0]),
      );
      total_supply = new BigNumber(
        toAe(pluginLogs.data.find((data) => data.name === 'Sell').args[1]),
      ).minus(volume);
    }

    const priceChangeData = pluginLogs.data?.find(
      (data) => data.name === 'PriceChange',
    );
    const _unit_price = _amount.div(volume);
    const _previous_buy_price = !!priceChangeData?.args
      ? new BigNumber(toAe(priceChangeData.args[0]))
      : _unit_price;
    const _buy_price = !!priceChangeData?.args
      ? new BigNumber(toAe(priceChangeData.args[1]))
      : _unit_price;
    const _market_cap = _buy_price.times(total_supply);

    const _sell_price = _buy_price
      .times(9950) // 9950 is the representation for 99.50% percent
      .dividedBy(10000); // sell_return_percentage 10000 is matching buy price, 5000 is considered half of buy price

    const [amount, unit_price, previous_buy_price, buy_price, sell_price, market_cap] =
      await Promise.all([
        this.aePricingService.getPriceData(_amount, tx.created_at, false),
        this.aePricingService.getPriceData(_unit_price, tx.created_at, false),
        this.aePricingService.getPriceData(_previous_buy_price, tx.created_at, false),
        this.aePricingService.getPriceData(_buy_price, tx.created_at, false),
        this.aePricingService.getPriceData(_sell_price, tx.created_at, false),
        this.aePricingService.getPriceData(_market_cap, tx.created_at, false),
      ]);

    // those not available on create_community without initial buy
    const priceChangeLogs = pluginLogs.data.find((log: any) => log.name === 'PriceChange');
    const transferLogs = pluginLogs.data.find((log: any) => log.name === 'Transfer');


    const txData = {
      sale_address: priceChangeLogs?.contract?.address,
      tx_type: tx.function,
      volume: volume.toNumber(),
      amount,
      market_cap,
      total_supply: total_supply.toNumber(),
      unit_price,
      previous_buy_price,
      buy_price,
      sell_price,
      protocol_reward: protocol_reward.toNumber(),
      dao_balance,
    }

    if (tx.function == BCL_CONTRACT.FUNCTIONS.create_community) {

      const communityName = createCommunityLogs.args[0];
      const collection = tx?.raw?.arguments?.[0]?.value;
      return {
        ...txData,

        address: transferLogs?.contract?.address,
        factory_address: createCommunityLogs?.contract?.address,
        dao_address: createCommunityLogs.args[1],
        sale_address: createCommunityLogs.args[2],
        creator_address: tx.caller_id,
        beneficiary_address: setOwnerLogs?.args[0],
        bonding_curve_address: null,
        owner_address: setOwnerLogs?.args[0],
        dao_balance: null,
        name: communityName,
        symbol: communityName,
        decimals: 18,
        collection: collection,
      };
    }

    return txData;
  }
}

