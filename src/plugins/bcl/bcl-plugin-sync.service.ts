import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { TransactionService } from '@/transactions/services/transaction.service';
import { TokensService } from '@/tokens/tokens.service';
import { AePricingService } from '@/ae-pricing/ae-pricing.service';
import { TokenWebsocketGateway } from '@/tokens/token-websocket.gateway';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Token } from '@/tokens/entities/token.entity';
import { ITransaction } from '@/utils/types';
import { BCL_FUNCTIONS } from '@/configs';
import { Encoded, toAe } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';
import moment from 'moment';

@Injectable()
export class BclPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(BclPluginSyncService.name);

  constructor(
    private readonly transactionService: TransactionService,
    private readonly tokenService: TokensService,
    private readonly aePricingService: AePricingService,
    private readonly tokenWebsocketGateway: TokenWebsocketGateway,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
  ) {
    super();
  }

  /**
   * Convert Tx entity to ITransaction format
   */
  private convertTxToITransaction(tx: Tx): ITransaction {
    return {
      hash: tx.hash,
      blockHeight: tx.block_height,
      blockHash: tx.block_hash as Encoded.BlockTxHash,
      signatures: tx.signatures,
      encodedTx: tx.encoded_tx || '',
      microIndex: parseInt(tx.micro_index, 10),
      microTime: parseInt(tx.micro_time, 10),
      pending: false,
      tx: tx.raw || {},
    } as ITransaction;
  }

  async processTransaction(tx: Tx): Promise<void> {
    try {
      const rawTransaction = this.convertTxToITransaction(tx);

      // Validate transaction
      if (
        !Object.keys(BCL_FUNCTIONS).includes(rawTransaction?.tx?.function) ||
        rawTransaction?.tx?.returnType === 'revert'
      ) {
        return;
      }

      let saleAddress: string;
      let token: Token | undefined;

      // Determine sale address
      if (rawTransaction.tx.function === BCL_FUNCTIONS.create_community) {
        if (!rawTransaction.tx.return?.value?.length) {
          return;
        }
        saleAddress = rawTransaction.tx.return.value[1].value;
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
        saleAddress = rawTransaction.tx.contractId;
      }

      // Get or create token
      try {
        token = await this.tokenService.getToken(saleAddress);
      } catch (error) {
        this.logger.error(`Error getting token ${saleAddress}`, error);
      }

      if (!token) {
        token =
          await this.tokenService.createTokenFromRawTransaction(rawTransaction);
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
      let decodedTransaction = await this.transactionService.decodeTransactionData(
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
      } = await this.transactionService.parseTransactionData(decodedTransaction);

      // Handle create_community special case
      if (
        decodedTransaction.tx.function == BCL_FUNCTIONS.create_community &&
        !token.factory_address
      ) {
        await this.tokenService.updateTokenMetaDataFromCreateTx(
          token,
          decodedTransaction,
        );
        token = await this.tokenService.findByAddress(token.sale_address);
      }

      // Calculate prices
      const decodedData = decodedTransaction.tx.decodedData;
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
        tx_type: decodedTransaction.tx.function,
        tx_hash: decodedTransaction.hash,
        block_height: decodedTransaction.blockHeight,
        address: decodedTransaction.tx.callerId,
        volume,
        protocol_reward,
        amount,
        unit_price,
        previous_buy_price,
        buy_price,
        total_supply,
        market_cap,
        created_at: moment(decodedTransaction.microTime).toDate(),
        verified:
          !_should_revalidate &&
          moment().diff(moment(decodedTransaction.microTime), 'hours') >= 5,
      };

      // Save transaction
      const transaction = await this.transactionRepository.save(txData);

      // Check if token is supported collection
      const isSupported = await this.transactionService.isTokenSupportedCollection(
        token,
      );

      if (!isSupported) {
        return;
      }

      // Broadcast transaction (shouldBroadcast = true for all plugin-processed transactions)
      // it should only broadcast if token is within supported collections
      await this.tokenService.syncTokenPrice(token);
      this.tokenWebsocketGateway?.handleTokenHistory({
        sale_address: saleAddress,
        data: txData,
        token: token,
      });
      // Update token holder
      await this.transactionService.updateTokenHolder(
        token,
        decodedTransaction,
        volume,
      );
      await this.tokenService.updateTokenTrendingScore(token);
    } catch (error: any) {
      this.handleError(error, tx, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }
}

