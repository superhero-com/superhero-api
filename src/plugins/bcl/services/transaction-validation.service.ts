import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { BCL_FUNCTIONS } from '@/configs';

@Injectable()
export class TransactionValidationService {
  private readonly logger = new Logger(TransactionValidationService.name);

  constructor(
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(Token)
    private tokenRepository: Repository<Token>,
    private readonly communityFactoryService: CommunityFactoryService,
  ) {}

  /**
   * Determine sale address from transaction
   * @param tx - Transaction entity
   * @returns Sale address or null if invalid
   */
  determineSaleAddress(tx: Tx): string | null {
    if (tx.function === BCL_FUNCTIONS.create_community) {
      if (!tx.raw?.return?.value?.length || tx.raw.return.value.length < 2) {
        return null;
      }
      return tx.raw.return.value[1]?.value || null;
    }
    if (tx.contract_id?.startsWith('ct_')) {
      return tx.contract_id;
    }
    const firstArgValue = tx.raw?.arguments?.[0]?.value;
    if (typeof firstArgValue === 'string' && firstArgValue.startsWith('ct_')) {
      return firstArgValue;
    }
    return null;
  }

  /**
   * Check if transaction already exists in database
   * @param txHash - Transaction hash
   * @returns True if transaction exists
   */
  async transactionExists(txHash: string): Promise<boolean> {
    const exists = await this.transactionRepository
      .createQueryBuilder('token_transactions')
      .where('token_transactions.tx_hash = :tx_hash', {
        tx_hash: txHash,
      })
      .getOne();

    return !!exists;
  }

  /**
   * Validate transaction and extract sale address
   * @param tx - Transaction entity
   * @returns Validation result with sale address
   */
  async validateTransaction(tx: Tx): Promise<{
    isValid: boolean;
    saleAddress: string | null;
  }> {
    if (!Object.values(BCL_FUNCTIONS).includes(tx.function)) {
      return { isValid: false, saleAddress: null };
    }
    // Check if transaction already exists
    const exists = await this.transactionExists(tx.hash);
    if (exists) {
      return { isValid: false, saleAddress: null };
    }

    // Determine sale address
    const saleAddress = this.determineSaleAddress(tx);
    if (!saleAddress || !saleAddress.startsWith('ct_')) {
      return { isValid: false, saleAddress: null };
    }

    // create_community must come from current factory contract
    if (tx.function === BCL_FUNCTIONS.create_community) {
      const currentFactory = await this.communityFactoryService.getCurrentFactory();
      if (tx.contract_id !== currentFactory.address) {
        return { isValid: false, saleAddress: null };
      }
      return { isValid: true, saleAddress };
    }

    // buy/sell must target an already known sale address
    // (prevents processing unrelated contracts that happen to expose same methods)
    const knownToken = await this.tokenRepository.exist({
      where: { sale_address: saleAddress },
    });
    if (!knownToken) {
      return { isValid: false, saleAddress: null };
    }

    return { isValid: true, saleAddress };
  }
}
