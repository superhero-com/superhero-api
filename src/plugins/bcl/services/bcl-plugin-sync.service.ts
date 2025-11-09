import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { BasePluginSyncService } from '../../base-plugin-sync.service';
import { SyncDirection } from '../../plugin.interface';
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
    @InjectRepository(Token)
    private tokenRepository: Repository<Token>,
  ) {
    super();
  }

  async processTransaction(rawTransaction: Tx, syncDirection: SyncDirection): Promise<void> {
    try {
      let saleAddress: string;

      // Determine sale address
      if (rawTransaction.function === BCL_FUNCTIONS.create_community) {
        if (!rawTransaction.raw?.return?.value?.length) {
          return;
        }
        saleAddress = rawTransaction.raw?.return.value[1].value;
      } else {
        saleAddress = rawTransaction.contract_id;
      }

      // Check if transaction already exists (outside transaction for early return)
      const exists = await this.transactionRepository
        .createQueryBuilder('token_transactions')
        .where('token_transactions.tx_hash = :tx_hash', {
          tx_hash: rawTransaction.hash,
        })
        .getOne();

      if (!!exists) {
        return;
      }

      // Wrap all DB operations in a single transaction
      const result = await this.transactionRepository.manager.transaction(
        async (manager) => {
          let transactionToken: Token | undefined;

          // Delete old transactions (if create_community)
          if (rawTransaction.function === BCL_FUNCTIONS.create_community) {
            await manager
              .createQueryBuilder()
              .delete()
              .from(Transaction)
              .where('sale_address = :sale_address', {
                sale_address: saleAddress,
              })
              .andWhere('tx_type = :tx_type', {
                tx_type: BCL_FUNCTIONS.create_community,
              })
              .andWhere('tx_hash != :tx_hash', {
                tx_hash: rawTransaction.hash,
              })
              .execute();
          }

          // Get or create token within transaction
          try {
            transactionToken = await this.bclTokenService.getToken(saleAddress);
          } catch (error) {
            this.logger.error(`Error getting token ${saleAddress}`, error);
          }

          if (!transactionToken) {
            transactionToken =
              await this.bclTokenService.createTokenFromRawTransaction(
                rawTransaction,
                manager,
              );
            if (!transactionToken) {
              throw new Error('Failed to create token');
            }
          }

          // Decode transaction data (requires token)
          const decodedTx = await this.bclTransactionsService.decodeTxEvents(
            transactionToken,
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
            !transactionToken.factory_address
          ) {
            await this.bclTokenService.updateTokenMetaDataFromCreateTx(
              transactionToken,
              decodedTx,
              manager,
            );
            transactionToken = await this.bclTokenService.findByAddress(
              transactionToken.sale_address,
              false,
              manager,
            );
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

          // Get price data (external API calls - outside transaction scope)
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
          const transactionRepository = manager.getRepository(Transaction);
          const savedTransaction = await transactionRepository.save(txData);

          // Update token's last_tx_hash and last_sync_block_height for live transactions only
          if (syncDirection === 'live') {
            transactionToken = await this.bclTokenService.update(
              transactionToken,
              {
                last_tx_hash: decodedTx.hash,
                last_sync_block_height: decodedTx.block_height,
              },
              manager,
            );
          }

          // Check if token is supported collection
          const isSupported =
            await this.bclTransactionsService.isTokenSupportedCollection(
              transactionToken,
            );

          if (!isSupported) {
            return { transactionToken, txData, savedTransaction, isSupported: false };
          }

          // Sync token price - only for live sync direction
          if (syncDirection === 'live') {
            await this.bclTokenService.syncTokenPrice(transactionToken, manager);
          }

          // Update token holder
          await this.bclTransactionsService.updateTokenHolder(
            transactionToken,
            decodedTx,
            volume,
            manager,
          );

          // Update token trending score
          await this.bclTokenService.updateTokenTrendingScore(transactionToken);

          return { transactionToken, txData, savedTransaction, isSupported: true };
        },
      );

      // Background operations outside transaction
      if (result && result.isSupported) {
        // Broadcast transaction via WebSocket
        this.tokenWebsocketGateway?.handleTokenHistory({
          sale_address: saleAddress,
          data: result.txData,
          token: result.transactionToken,
        });
      }
    } catch (error: any) {
      this.handleError(error, rawTransaction, 'processTransaction');
      throw error; // Re-throw to let BasePluginSyncService handle it
    }
  }
}

