import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { SyncDirection } from '../../plugin.interface';
import { decode, toAe } from '@aeternity/aepp-sdk';
import { Tip } from '@/tipping/entities/tip.entity';
import { Account } from '@/account/entities/account.entity';
import { Post } from '@/social/entities/post.entity';
import { TokensService } from '@/tokens/tokens.service';
import { refreshTrendingScoresForPostSafely } from '@/social/utils/token-mentions.util';
import { isSelfTip } from '@/tipping/utils/is-self-tip.util';

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
    private readonly tokensService: TokensService,
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
    void syncDirection;
    try {
      // Validate transaction
      const tipType = this.validateTransaction(tx);
      if (!tipType) {
        return null;
      }

      // Wrap persistence in a transaction, then recalculate after commit.
      const savedTipResult = await this.tipRepository.manager.transaction(
        async (manager) => {
          return await this.saveTipFromTransaction(tx, tipType, manager);
        },
      );

      if (!savedTipResult) {
        return null;
      }

      await refreshTrendingScoresForPostSafely({
        post: savedTipResult.post,
        loadParentPost: (postId) =>
          this.postRepository.findOne({
            where: { id: postId },
          }),
        updateTrendingScoresForSymbols: (symbols) =>
          this.tokensService.updateTrendingScoresForSymbols(symbols),
        logError: (message, trace) => this.logger.error(message, trace),
        errorMessage:
          'Failed to refresh trending scores after processing tip transaction',
      });

      return savedTipResult.tip;
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
  private validateTransaction(tx: Tx): false | 'TIP_PROFILE' | 'TIP_POST' {
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
  ): Promise<{ tip: Tip; post: Post | null } | null> {
    const tipRepository = manager.getRepository(Tip);

    const amount = tx?.raw?.amount ? toAe(tx.raw.amount) : '0';

    if (!tx.sender_id || !tx.recipient_id) {
      throw new Error(
        `Missing sender or receiver address for transaction ${tx.hash}`,
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

    if (isSelfTip(tx.sender_id, tx.recipient_id, post)) {
      return null;
    }

    // Ensure sender and receiver accounts exist
    const [senderAccount, receiverAccount] = await Promise.all([
      this.ensureAccountExists(tx.sender_id, manager),
      this.ensureAccountExists(tx.recipient_id, manager),
    ]);

    if (!senderAccount || !receiverAccount) {
      throw new Error(`Failed to create accounts for transaction ${tx.hash}`);
    }

    // Use upsert to handle duplicate key violations gracefully during parallel processing
    await tipRepository.upsert(
      {
        tx_hash: tx.hash,
        sender: senderAccount,
        receiver: receiverAccount,
        amount,
        type: tipType, // Save full tip type string to match TipService behavior
        post,
      },
      {
        conflictPaths: ['tx_hash'],
        skipUpdateIfNoValuesChanged: true,
      },
    );

    // Fetch and return the tip (either newly created or existing)
    return {
      tip: await tipRepository.findOneOrFail({
        where: { tx_hash: tx.hash },
      }),
      post,
    };
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

      // Use upsert to handle duplicate key violations gracefully during parallel processing
      await accountRepository.upsert(
        { address },
        {
          conflictPaths: ['address'],
          skipUpdateIfNoValuesChanged: true,
        },
      );

      // Fetch and return the account
      return await accountRepository.findOne({
        where: { address },
      });
    } catch (error) {
      this.logger.error(`Failed to ensure account exists: ${address}`, error);
      return null;
    }
  }
}
