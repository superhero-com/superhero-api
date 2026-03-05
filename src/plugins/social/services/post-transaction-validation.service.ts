import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from '@/social/entities/post.entity';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { IPostContract } from '@/social/interfaces/post.interfaces';
import {
  getContractByAddress,
  isContractSupported,
} from '../config/post-contracts.config';

export interface PostTransactionValidationResult {
  isValid: boolean;
  contract?: IPostContract;
  postExists?: boolean;
  error?: string;
}

@Injectable()
export class PostTransactionValidationService {
  private readonly logger = new Logger(PostTransactionValidationService.name);

  constructor(
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Validates transaction data structure
   */
  validateTransactionStructure(tx: Tx): boolean {
    if (!tx) {
      return false;
    }

    if (!tx.hash) {
      this.logger.warn('Transaction missing hash');
      return false;
    }

    if (!tx.micro_time) {
      this.logger.warn('Transaction missing micro_time');
      return false;
    }

    if (!tx.contract_id && !tx.raw?.contractId) {
      this.logger.warn('Transaction missing contract ID');
      return false;
    }

    if (!tx.caller_id && !tx.raw?.callerId) {
      this.logger.warn('Transaction missing caller ID');
      return false;
    }

    if (!tx.raw?.arguments) {
      this.logger.warn('Transaction missing arguments');
      return false;
    }

    return true;
  }

  /**
   * Check if post already exists by transaction hash
   */
  async postExists(txHash: string): Promise<boolean> {
    const existingPost = await this.postRepository.findOne({
      where: { tx_hash: txHash },
    });
    return !!existingPost;
  }

  /**
   * Validate transaction and contract support
   */
  async validateTransaction(tx: Tx): Promise<PostTransactionValidationResult> {
    // Validate transaction structure
    if (!this.validateTransactionStructure(tx)) {
      return {
        isValid: false,
        error: 'Invalid transaction structure',
      };
    }

    const contractAddress = tx.contract_id || tx.raw?.contractId;

    // Get contracts from config
    const contracts = this.configService.get<IPostContract[]>(
      'social.contracts',
      [],
    );

    // Check contract support
    if (!contractAddress || !isContractSupported(contracts, contractAddress)) {
      return {
        isValid: false,
        error: 'Missing contract ID or unsupported contract',
      };
    }

    const contract = getContractByAddress(contracts, contractAddress);
    if (!contract) {
      this.logger.error('Contract configuration not found', {
        contractAddress,
      });
      return {
        isValid: false,
        error: 'Contract configuration missing',
      };
    }

    // Check if post already exists
    const exists = await this.postExists(tx.hash);

    return {
      isValid: true,
      contract,
      postExists: exists,
    };
  }
}
