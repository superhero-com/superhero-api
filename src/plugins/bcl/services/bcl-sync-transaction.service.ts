import { Injectable, Logger } from '@nestjs/common';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { TransactionService } from './transaction.service';

@Injectable()
export class BclSyncTransactionService extends BasePluginSyncService {
  protected readonly logger = new Logger(BclSyncTransactionService.name);

  constructor(private readonly transactionService: TransactionService) {
    super();
  }

  async processTransaction(tx: Tx): Promise<void> {
    try {
      // Use the existing TransactionService to handle BCL transactions
      await this.transactionService.saveTransaction(tx.raw, null, true);
    } catch (error: any) {
      this.handleError(error, tx, 'BclSyncTransactionService');
    }
  }
}
