import { Account } from '@/account/entities/account.entity';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tip } from '../../plugins/tipping/entities/tip.entity';
import { ITransaction } from '@/utils/types';
import { decode, toAe } from '@aeternity/aepp-sdk';
import { Post } from '@/plugins/social/entities/post.entity';

@Injectable()
export class TipService {
  private readonly logger = new Logger(TipService.name);
  private readonly isProcessing = new Map<string, boolean>();

  constructor(
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,

    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,

    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {
    this.logger.log('TipService initialized');
  }

  // async onModuleInit(): Promise<void> {
  //   //
  // }

  async handleLiveTransaction(transaction: ITransaction): Promise<{
    success: boolean;
    tip?: any;
    error?: string;
    skipped?: boolean;
    reason?: string;
  }> {
    const type = this.validateTransaction(transaction);
    if (!type) {
      return {
        success: false,
        error: 'Missing contract ID or unsupported contract',
        skipped: true,
      };
    }
    try {
      const tip = await this.saveTipFromTransaction(transaction, type);
      return {
        success: true,
        tip,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        skipped: true,
      };
    }
  }

  async saveTransaction(transaction: ITransaction) {
    const type = this.validateTransaction(transaction);
    if (!type) {
      return;
    }
    return this.saveTipFromTransaction(transaction, type);
  }

  async saveTipFromTransaction(
    transaction: ITransaction,
    type: 'TIP_PROFILE' | 'TIP_POST',
  ) {
    const existingTip = await this.tipRepository.findOne({
      where: {
        tx_hash: transaction.hash,
      },
    });

    if (existingTip) {
      return existingTip;
    }

    const senderAddress = transaction.tx.senderId;
    const receiverAddress = transaction.tx.recipientId;
    const amount = toAe(transaction.tx.amount);

    // Ensure sender and receiver accounts exist
    const [senderAccount, receiverAccount] = await Promise.all([
      this.ensureAccountExists(senderAddress),
      this.ensureAccountExists(receiverAddress),
    ]);

    let post = null;

    if (type.startsWith('TIP_POST')) {
      try {
        const postId = type.split('TIP_POST:')[1];
        post = await this.postRepository.findOne({
          where: { id: postId },
        });
      } catch (error) {
        this.logger.error('Failed to find post', {
          postId: type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return await this.tipRepository.save({
      tx_hash: transaction.hash,
      sender: senderAccount,
      receiver: receiverAccount,
      amount,
      type,
      post,
    });
  }

  /**
   * Ensures an account exists, creates it if it doesn't
   */
  private async ensureAccountExists(address: string): Promise<Account> {
    try {
      let existingAccount = await this.accountRepository.findOne({
        where: { address },
      });

      if (!existingAccount) {
        existingAccount = await this.accountRepository.save({
          address,
        });
        this.logger.log(`Created new account: ${address}`);
      }
      return existingAccount;
    } catch (error) {
      this.logger.error(`Failed to ensure account exists: ${address}`, error);
      // Don't throw - account creation failure shouldn't break tip processing
    }
    return null;
  }

  /**
   * Validates transaction data structure
   */
  private validateTransaction(
    transaction: ITransaction,
  ): false | 'TIP_PROFILE' | 'TIP_POST' {
    if (!transaction || transaction.tx.type !== 'SpendTx') {
      return false;
    }

    const payload = transaction.tx.payload;
    if (!payload) {
      return false;
    }
    const payloadData = decode(transaction.tx.payload).toString();

    const supportedPayloads = ['TIP_PROFILE', 'TIP_POST'];
    if (!supportedPayloads.some((payload) => payloadData.startsWith(payload))) {
      return false;
    }

    return payloadData as 'TIP_PROFILE' | 'TIP_POST';
  }
}
