import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Tip } from '@/plugins/tipping/entities/tip.entity';
import { Post } from '@/plugins/social/entities/post.entity';
import { Account } from '@/plugins/account/entities/account.entity';
import { decode, toAe } from '@aeternity/aepp-sdk';

@Injectable()
export class TippingSyncTransactionService extends BasePluginSyncService {
  protected readonly logger = new Logger(TippingSyncTransactionService.name);

  constructor(
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {
    super();
  }

  async processTransaction(tx: Tx): Promise<void> {
    const type = this.validateTransaction(tx);
    if (!type) {
      return;
    }

    await this.saveTipFromTransaction(tx, type);
  }

  private validateTransaction(tx: Tx): false | 'TIP_PROFILE' | 'TIP_POST' {
    if (!tx || tx.raw?.tx?.type !== 'SpendTx') {
      return false;
    }

    const payload = tx.raw.tx.payload;
    if (!payload) {
      return false;
    }

    try {
      const payloadData = decode(tx.raw.tx.payload).toString();
      const supportedPayloads = ['TIP_PROFILE', 'TIP_POST'];
      if (
        !supportedPayloads.some((payload) => payloadData.startsWith(payload))
      ) {
        return false;
      }
      return payloadData as 'TIP_PROFILE' | 'TIP_POST';
    } catch (error) {
      return false;
    }
  }

  private async saveTipFromTransaction(
    tx: Tx,
    type: 'TIP_PROFILE' | 'TIP_POST',
  ): Promise<Tip | null> {
    const existingTip = await this.tipRepository.findOne({
      where: {
        tx_hash: tx.tx_hash,
      },
    });

    if (existingTip) {
      return existingTip;
    }

    const senderAddress = tx.sender_id;
    const receiverAddress = tx.recipient_id;
    const amount = toAe(tx.raw.tx.amount);

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
      tx_hash: tx.tx_hash,
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
  private async ensureAccountExists(address: string): Promise<Account | null> {
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
      return null;
    }
  }
}
