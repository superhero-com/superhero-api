import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirection } from '../../plugin.interface';
import { decode, toAe } from '@aeternity/aepp-sdk';
import { Tip } from '@/tipping/entities/tip.entity';
import { Account } from '@/account/entities/account.entity';
import { Post } from '@/social/entities/post.entity';

@Injectable()
export class SocialTippingTransactionProcessorService {
  private readonly logger = new Logger(
    SocialTippingTransactionProcessorService.name,
  );

  constructor(
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    @InjectRepository(Post)
    private readonly postRepository: Repository<Post>,
  ) {}

  /**
   * Process a tip transaction
   * @param tx - Transaction entity from MDW sync
   * @param syncDirection - Sync direction (backward/live/reorg)
   * @returns Tip if processed successfully, null otherwise
   */
  async processTransaction(
    tx: Tx,
    syncDirection: SyncDirection,
  ): Promise<Tip | null> {
    try {
      // Validate transaction
      const tipType = this.validateTransaction(tx);
      if (!tipType) {
        return null;
      }

      // Wrap operations in a transaction for consistency
      return await this.tipRepository.manager.transaction(
        async (manager) => {
          return await this.saveTipFromTransaction(tx, tipType, manager);
        },
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to process tip transaction ${tx.hash}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Validate transaction and determine tip type
   */
  private validateTransaction(
    tx: Tx,
  ): false | 'TIP_PROFILE' | 'TIP_POST' {
    if (!tx || tx.type !== 'SpendTx' || !tx.raw?.payload) {
      return false;
    }


    try {
      const payloadData = decode(tx.raw.payload).toString();
      const supportedPayloads = ['TIP_PROFILE', 'TIP_POST'];
      if (
        !supportedPayloads.some((payload) => payloadData.startsWith(payload))
      ) {
        return false;
      }

      return payloadData as 'TIP_PROFILE' | 'TIP_POST';
    } catch (error) {
      this.logger.debug(`Failed to decode payload for transaction ${tx.hash}`);
      return false;
    }
  }

  /**
   * Save tip from transaction
   */
  private async saveTipFromTransaction(
    tx: Tx,
    tipType: 'TIP_PROFILE' | 'TIP_POST',
    manager: EntityManager,
  ): Promise<Tip> {
    const tipRepository = manager.getRepository(Tip);

    // Check if tip already exists
    const existingTip = await tipRepository.findOne({
      where: {
        tx_hash: tx.hash,
      },
    });

    if (existingTip) {
      return existingTip;
    }

    const amount = tx?.raw?.amount
      ? toAe(tx.raw.amount)
      : '0';

    if (!tx.sender_id || !tx.recipient_id) {
      throw new Error(
        `Missing sender or receiver address for transaction ${tx.hash}`,
      );
    }

    // Ensure sender and receiver accounts exist
    const [senderAccount, receiverAccount] = await Promise.all([
      this.ensureAccountExists(tx.sender_id, manager),
      this.ensureAccountExists(tx.recipient_id, manager),
    ]);

    if (!senderAccount || !receiverAccount) {
      throw new Error(
        `Failed to create accounts for transaction ${tx.hash}`,
      );
    }

    // Handle post tip
    let post = null;
    if (tipType.startsWith('TIP_POST')) {
      try {
        const postId = tipType.split('TIP_POST:')[1];
        post = await manager.getRepository(Post).findOne({
          where: { id: postId },
        });
      } catch (error) {
        this.logger.error('Failed to find post', {
          postId: tipType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return await tipRepository.save({
      tx_hash: tx.hash,
      sender: senderAccount,
      receiver: receiverAccount,
      amount,
      type: tipType, // Save full tip type string to match TipService behavior
      post,
    });
  }

  /**
   * Ensures an account exists, creates it if it doesn't
   */
  private async ensureAccountExists(
    address: string,
    manager: EntityManager,
  ): Promise<Account | null> {
    try {
      const accountRepository = manager.getRepository(Account);
      let existingAccount = await accountRepository.findOne({
        where: { address },
      });

      if (!existingAccount) {
        existingAccount = await accountRepository.save({
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

