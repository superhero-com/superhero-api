import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Token } from '@/tokens/entities/token.entity';
import { SyncDirection } from '../../plugin.interface';
import { BclTransactionValidationService } from './bcl-transaction-validation.service';
import {
  BclTransactionDataService,
  TransactionData,
} from './bcl-transaction-data.service';
import { BclTransactionPersistenceService } from './bcl-transaction-persistence.service';
import { BclTransactionsService } from './bcl-transactions.service';
import { BclTokenService } from './bcl-token.service';
import { BCL_FUNCTIONS } from '@/configs';

export interface ProcessTransactionResult {
  transactionToken: Token;
  txData: TransactionData;
  savedTransaction: Transaction;
  isSupported: boolean;
}

@Injectable()
export class BclTransactionProcessorService {
  private readonly logger = new Logger(BclTransactionProcessorService.name);

  constructor(
    private readonly validationService: BclTransactionValidationService,
    private readonly dataService: BclTransactionDataService,
    private readonly persistenceService: BclTransactionPersistenceService,
    private readonly bclTransactionsService: BclTransactionsService,
    private readonly bclTokenService: BclTokenService,
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
    const validation = await this.validationService.validateTransaction(
      rawTransaction,
    );
    if (!validation.isValid || !validation.saleAddress) {
      return null;
    }

    const saleAddress = validation.saleAddress;

    // Wrap all DB operations in a single transaction
    const result = await this.transactionRepository.manager.transaction(
      async (manager) => {
        let transactionToken: Token | undefined;

        // Delete old transactions (if create_community)
        if (rawTransaction.function === BCL_FUNCTIONS.create_community) {
          await this.persistenceService.cleanupOldTransactions(
            saleAddress,
            rawTransaction.hash,
            manager,
          );
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
        const parsedData =
          await this.bclTransactionsService.parseTransactionData(decodedTx);

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

        // Save transaction
        const savedTransaction =
          await this.persistenceService.saveTransaction(txData, manager);

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
          return {
            transactionToken,
            txData,
            savedTransaction,
            isSupported: false,
          };
        }

        // Sync token price - only for live sync direction
        if (syncDirection === 'live') {
          await this.bclTokenService.syncTokenPrice(transactionToken, manager);
        }

        // Update token holder
        await this.bclTransactionsService.updateTokenHolder(
          transactionToken,
          decodedTx,
          parsedData.volume,
          manager,
        );

        // Update token trending score
        await this.bclTokenService.updateTokenTrendingScore(transactionToken);

        return {
          transactionToken,
          txData,
          savedTransaction,
          isSupported: true,
        };
      },
    );

    return result;
  }
}

