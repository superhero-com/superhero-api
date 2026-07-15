import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Token } from '@/tokens/entities/token.entity';
import { SyncDirection, SyncDirectionEnum } from '../../plugin.interface';
import { TransactionValidationService } from './transaction-validation.service';
import {
  TransactionDataService,
  TransactionData,
} from './transaction-data.service';
import { TransactionPersistenceService } from './transaction-persistence.service';
import { TransactionsService } from './transactions.service';
import { TokenService } from './token.service';
import { TokenHolderService } from './token-holder.service';
import { BCL_FUNCTIONS } from '@/configs';

export interface ProcessTransactionResult {
  transactionToken: Token;
  txData: TransactionData;
  savedTransaction: Transaction;
  isSupported: boolean;
}

const REPROCESSABLE_BCL_FUNCTIONS = [BCL_FUNCTIONS.buy, BCL_FUNCTIONS.sell];

@Injectable()
export class TransactionProcessorService {
  private readonly logger = new Logger(TransactionProcessorService.name);

  constructor(
    private readonly validationService: TransactionValidationService,
    private readonly dataService: TransactionDataService,
    private readonly persistenceService: TransactionPersistenceService,
    private readonly transactionsService: TransactionsService,
    private readonly tokenService: TokenService,
    private readonly tokenHolderService: TokenHolderService,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
  ) {}

  /**
   * Process a transaction end-to-end
   * @param rawTransaction - Raw transaction entity
   * @param syncDirection - Sync direction (backward/live/reorg)
   * @returns Processing result or null if transaction should be skipped
   */
  async processTransaction(
    rawTransaction: Tx,
    syncDirection: SyncDirection,
  ): Promise<ProcessTransactionResult | null> {
    // Validate transaction and get sale address
    const validation =
      await this.validationService.validateTransaction(rawTransaction);
    if (!validation.isValid || !validation.saleAddress) {
      return null;
    }

    const saleAddress = validation.saleAddress;

    // Deferred `tgr.balance.changed` emit from updateTokenHolder — fired only
    // AFTER the transaction below commits, so room eligibility never recomputes
    // off a balance a rollback discards (or one not yet visible to its reader).
    let emitBalanceChanged: (() => void) | null = null;

    // Wrap all DB operations in a single transaction
    const result = await this.transactionRepository.manager.transaction(
      async (manager) => {
        let transactionToken: Token | undefined;
        let cleanupAffectedAddresses: string[] = [];

        // Resolve token first. For buy/sell this may lazily create token by sale
        // address via TokensService.getToken().
        try {
          transactionToken = await this.tokenService.getToken(saleAddress);
        } catch (error) {
          this.logger.error(`Error getting token ${saleAddress}`, error);
        }

        if (!transactionToken) {
          if (rawTransaction.function !== BCL_FUNCTIONS.create_community) {
            this.logger.warn(
              `Skipping ${rawTransaction.function} tx ${rawTransaction.hash}: token unavailable for ${saleAddress}`,
            );
            return null;
          }

          transactionToken =
            await this.tokenService.createTokenFromRawTransaction(
              rawTransaction,
              manager,
            );
          if (!transactionToken) {
            this.logger.warn(
              `Skipping create_community tx ${rawTransaction.hash}: failed to create token for ${saleAddress}`,
            );
            return null;
          }
        }

        // Decode transaction data (requires token)
        const decodedTx = await this.transactionsService.decodeTxEvents(
          transactionToken,
          rawTransaction,
        );

        // Parse transaction data
        const parsedData =
          await this.transactionsService.parseTransactionData(decodedTx);

        if (
          parsedData._should_revalidate &&
          REPROCESSABLE_BCL_FUNCTIONS.includes(
            rawTransaction.function as (typeof REPROCESSABLE_BCL_FUNCTIONS)[number],
          )
        ) {
          throw new Error(
            `Missing decoded events for ${rawTransaction.function} transaction ${rawTransaction.hash}`,
          );
        }

        // Handle create_community special case
        if (
          decodedTx.function === BCL_FUNCTIONS.create_community &&
          !transactionToken.factory_address
        ) {
          await this.tokenService.updateTokenMetaDataFromCreateTx(
            transactionToken,
            decodedTx,
            manager,
          );
          transactionToken = await this.tokenService.findByAddress(
            transactionToken.sale_address,
            false,
            manager,
          );
          if (!transactionToken) {
            this.logger.warn(
              `Skipping create_community tx ${rawTransaction.hash}: token disappeared after metadata update for ${saleAddress}`,
            );
            return null;
          }
        }

        // Calculate prices
        const priceCalculations = this.dataService.calculatePrices(
          decodedTx,
          parsedData,
        );

        // Prepare transaction data (includes external API calls)
        const txData = await this.dataService.prepareTransactionData(
          saleAddress,
          decodedTx,
          parsedData,
          priceCalculations,
        );

        // Delete stale create_community rows only once the replacement row is ready.
        if (rawTransaction.function === BCL_FUNCTIONS.create_community) {
          cleanupAffectedAddresses =
            await this.persistenceService.cleanupOldTransactions(
              saleAddress,
              rawTransaction.hash,
              manager,
            );
        }

        // Save transaction
        const savedTransaction = await this.persistenceService.saveTransaction(
          txData,
          manager,
        );

        for (const address of new Set(cleanupAffectedAddresses)) {
          if (address && address !== txData.address) {
            try {
              await this.persistenceService.refreshAccountFromTransactions(
                address,
                manager,
              );
            } catch (error) {
              this.logger.error(
                `Failed to refresh account totals for ${address}`,
                error instanceof Error ? error.stack : String(error),
              );
            }
          }
        }

        // Update token's last_tx_hash and last_sync_block_height for live transactions only
        if (syncDirection === SyncDirectionEnum.Live) {
          const updatedToken = await this.tokenService.update(
            transactionToken,
            {
              last_tx_hash: decodedTx.hash,
              last_sync_block_height: decodedTx.block_height,
            },
            manager,
          );
          if (updatedToken) {
            transactionToken = updatedToken;
          } else {
            this.logger.warn(
              `Token update returned null for ${saleAddress}; continuing with in-memory token`,
            );
          }
        }

        // Check if token is supported collection
        const isSupported =
          await this.transactionsService.isTokenSupportedCollection(
            transactionToken,
          );

        if (!isSupported) {
          return {
            transactionToken,
            txData,
            savedTransaction,
            isSupported: false,
          };
        }

        // Sync token price - only for live sync direction
        if (syncDirection === SyncDirectionEnum.Live) {
          await this.tokenService.syncTokenPrice(transactionToken, manager);

          // Update token holder. The balance-changed emit is deferred and
          // fired after this transaction commits (see below).
          emitBalanceChanged = await this.tokenHolderService.updateTokenHolder(
            transactionToken,
            decodedTx,
            parsedData.volume,
            manager,
          );
        }

        return {
          transactionToken,
          txData,
          savedTransaction,
          isSupported: true,
        };
      },
    );

    // Transaction committed — now it is safe to wake room eligibility off the
    // freshly-persisted (and durable) token_balance. If the transaction had
    // rolled back, `.transaction()` would have thrown and we would never reach
    // this line, so a discarded balance never emits.
    emitBalanceChanged?.();

    // Update token trending score (non-critical operation outside transaction)
    if (result?.isSupported && syncDirection === SyncDirectionEnum.Live) {
      try {
        await this.tokenService.updateTokenTrendingScore(
          result.transactionToken,
        );
      } catch (error) {
        this.logger.error(
          `Failed to update trending score for token ${result.transactionToken.sale_address}`,
          error,
        );
        // Don't throw - this is a non-critical operation
      }
    }

    return result;
  }
}
