import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import { BclTransactionsService } from './bcl-transactions.service';
import { BclTokenService } from './bcl-token.service';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Token } from '@/tokens/entities/token.entity';
import { BCL_FUNCTIONS } from '@/configs';
import { toAe } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';
import moment from 'moment';

@Injectable()
export class BclPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(BclPluginSyncService.name);

  constructor(
    private readonly bclTransactionsService: BclTransactionsService,
    private readonly bclTokenService: BclTokenService,
    private readonly aePricingService: AePricingService,
    private readonly tokenWebsocketGateway: TokenWebsocketGateway,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
  ) {
    super();
  }

  async processTransaction(rawTransaction: Tx, syncDirection: SyncDirection): Promise<void> {
    try {

      let saleAddress: string;
      let token: Token | undefined;

      // Determine sale address
      if (rawTransaction.function === BCL_FUNCTIONS.create_community) {
        if (!rawTransaction.raw?.return?.value?.length) {
          return;
        }
        saleAddress = rawTransaction.raw?.return.value[1].value;
        // Remove any transaction with the same sale address
        await this.transactionRepository
          .createQueryBuilder('transactions')
          .delete()
          .where('transactions.sale_address = :sale_address', {
            sale_address: saleAddress,
          })
          .andWhere('transactions.tx_type = :tx_type', {
            tx_type: BCL_FUNCTIONS.create_community,
          })
          .andWhere('transactions.tx_hash != :tx_hash', {
            tx_hash: rawTransaction.hash,
          })
          .execute();
      } else {
        saleAddress = rawTransaction.contract_id;
      }

      // Get or create token
      try {
        token = await this.bclTokenService.getToken(saleAddress);
      } catch (error) {
        this.logger.error(`Error getting token ${saleAddress}`, error);
      }

      if (!token) {
        token =
          await this.bclTokenService.createTokenFromRawTransaction(rawTransaction);
        if (!token) {
          return;
        }
      }

      // Check if transaction already exists
      const exists = await this.transactionRepository
        .createQueryBuilder('token_transactions')
        .where('token_transactions.tx_hash = :tx_hash', {
          tx_hash: rawTransaction.hash,
        })
        .getOne();

      if (!!exists) {
        return;
      }

      // Decode transaction data
      const decodedTx = await this.bclTransactionsService.decodeTxEvents(
        token,
        rawTransaction,
      );

      // Parse transaction data
      const {
        amount: _amount,
        volume,
        total_supply,
        protocol_reward,
        _should_revalidate,
      } = await this.bclTransactionsService.parseTransactionData(decodedTx);

      // Handle create_community special case
      if (
        decodedTx.function === BCL_FUNCTIONS.create_community &&
        !token.factory_address
      ) {
        await this.bclTokenService.updateTokenMetaDataFromCreateTx(
          token,
          decodedTx,
        );
        token = await this.bclTokenService.findByAddress(token.sale_address);
      }

      // Calculate prices
      const decodedData = decodedTx.raw?.decodedData;
      const priceChangeData = decodedData?.find(
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

      // Get price data
      const [amount, unit_price, previous_buy_price, buy_price, market_cap] =
        await Promise.all([
          this.aePricingService.getPriceData(_amount),
          this.aePricingService.getPriceData(_unit_price),
          this.aePricingService.getPriceData(_previous_buy_price),
          this.aePricingService.getPriceData(_buy_price),
          this.aePricingService.getPriceData(_market_cap),
        ]);

      // Prepare transaction data
      const txData = {
        sale_address: saleAddress,
        tx_type: decodedTx.function,
        tx_hash: decodedTx.hash,
        block_height: decodedTx.block_height,
        address: decodedTx.caller_id,
        volume,
        protocol_reward,
        amount,
        unit_price,
        previous_buy_price,
        buy_price,
        total_supply,
        market_cap,
        created_at: moment(parseInt(decodedTx.micro_time, 10)).toDate(),
        verified:
          !_should_revalidate &&
          moment().diff(moment(parseInt(decodedTx.micro_time, 10)), 'hours') >= 5,
      };

      // Save transaction
      const transaction = await this.transactionRepository.save(txData);
      // Update token's last_tx_hash and last_sync_block_height for live transactions only
      if (syncDirection === 'live') {
        await this.bclTokenService.update(token, {
          last_tx_hash: decodedTx.hash,
          last_sync_block_height: decodedTx.block_height,
        });
      }

      // Check if token is supported collection
      const isSupported = await this.bclTransactionsService.isTokenSupportedCollection(
        token,
      );

      if (!isSupported) {
        return;
      }

      // Broadcast transaction (shouldBroadcast = true for all plugin-processed transactions)
      // it should only broadcast if token is within supported collections
      await this.bclTokenService.syncTokenPrice(token);
      this.tokenWebsocketGateway?.handleTokenHistory({
        sale_address: saleAddress,
        data: txData,
        token: token,
      });
      // Update token holder
      await this.bclTransactionsService.updateTokenHolder(
        token,
        decodedTx,
        volume,
      );
      await this.bclTokenService.updateTokenTrendingScore(token);
    } catch (error: any) {
      this.handleError(error, rawTransaction, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }
}

