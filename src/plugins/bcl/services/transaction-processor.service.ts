import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
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
import { BCL_FUNCTIONS } from '@/configs';

export interface ProcessTransactionResult {
  transactionToken: Token;
  txData: TransactionData;
  savedTransaction: Transaction;
  isSupported: boolean;
}

@Injectable()
export class TransactionProcessorService {
  private readonly logger = new Logger(TransactionProcessorService.name);

  constructor(
    private readonly validationService: TransactionValidationService,
    private readonly dataService: TransactionDataService,
    private readonly persistenceService: TransactionPersistenceService,
    private readonly transactionsService: TransactionsService,
    private readonly tokenService: TokenService,
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
          transactionToken = await this.tokenService.getToken(saleAddress);
        } catch (error) {
          this.logger.error(`Error getting token ${saleAddress}`, error);
        }

        if (!transactionToken) {
          transactionToken =
            await this.tokenService.createTokenFromRawTransaction(
              rawTransaction,
              manager,
            );
          if (!transactionToken) {
            throw new Error('Failed to create token');
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
        if (syncDirection === SyncDirectionEnum.Live) {
          transactionToken = await this.tokenService.update(
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
        }

        // Update token holder
        await this.transactionsService.updateTokenHolder(
          transactionToken,
          decodedTx,
          parsedData.volume,
          manager,
        );

        // Update token trending score
        await this.tokenService.updateTokenTrendingScore(transactionToken);

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

