import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Token } from '@/tokens/entities/token.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { TokensService } from '@/tokens/tokens.service';
import { BCL_FUNCTIONS } from '@/configs';
import { Encoded } from '@aeternity/aepp-sdk';
import BigNumber from 'bignumber.js';

@Injectable()
export class TokenHolderService {
  private readonly logger = new Logger(TokenHolderService.name);

  constructor(
    @InjectRepository(TokenHolder)
    private tokenHolderRepository: Repository<TokenHolder>,
    private readonly tokenService: TokensService,
  ) {}

  /**
   * Determine if transaction increases token balance (buy or create_community with volume)
   */
  private isBuyTransaction(tx: Tx, volume: BigNumber): boolean {
    return (
      tx.function === BCL_FUNCTIONS.buy ||
      (tx.function === BCL_FUNCTIONS.create_community && volume.gt(0))
    );
  }

  /**
   * Calculate new balance based on transaction type
   */
  private calculateNewBalance(
    currentBalance: BigNumber,
    volume: BigNumber,
    isBuy: boolean,
  ): BigNumber {
    const normalizedBalance = currentBalance.isNegative()
      ? new BigNumber(0)
      : currentBalance;
    return isBuy
      ? normalizedBalance.plus(volume)
      : normalizedBalance.minus(volume);
  }

  /**
   * Update token holders count
   */
  private async updateTokenHoldersCount(
    token: Token,
    newCount: number,
    manager?: EntityManager,
  ): Promise<void> {
    if (manager) {
      await manager.getRepository(Token).update(token.sale_address, {
        holders_count: newCount,
      });
    } else {
      await this.tokenService.update(token, {
        holders_count: newCount,
      });
    }
  }

  /**
   * Update token holder based on transaction
   * Optimized for performance with single query and simplified logic
   */
  async updateTokenHolder(
    token: Token,
    tx: Tx,
    volume: BigNumber,
    manager?: EntityManager,
  ): Promise<void> {
    // Early return if token.address is null (token not yet initialized)
    if (!token.address) {
      return;
    }

    // Determine transaction type upfront
    const isBuy = this.isBuyTransaction(tx, volume);

    try {
      const bigNumberVolume = new BigNumber(volume).multipliedBy(10 ** 18);
      const repository =
        manager?.getRepository(TokenHolder) || this.tokenHolderRepository;

      // Single query to find existing holder
      const tokenHolder = await repository.findOne({
        where: {
          aex9_address: token.address,
          address: tx.caller_id,
        },
      });

      if (tokenHolder) {
        // Update existing holder
        const newBalance = this.calculateNewBalance(
          tokenHolder.balance,
          bigNumberVolume,
          isBuy,
        );

        await repository.update(tokenHolder.id, {
          balance: newBalance,
          last_tx_hash: tx.hash,
          block_number: tx.block_height,
        });

        // Fix holders_count if it's incorrectly set to 0
        if (token.holders_count === 0) {
          await this.updateTokenHoldersCount(token, 1, manager);
        }
      } else {
        // Create new holder (only for buy transactions)
        if (!isBuy) {
          // Can't create holder for sell transaction
          return;
        }

        await repository.save({
          id: `${tx.caller_id}_${token.address}`,
          aex9_address: token.address,
          address: tx.caller_id,
          balance: bigNumberVolume,
          last_tx_hash: tx.hash,
          block_number: tx.block_height,
        });

        // Get current holders count only when creating new holder
        const tokenHolderCount = await repository
          .createQueryBuilder('token_holders')
          .where('token_holders.aex9_address = :aex9_address', {
            aex9_address: token.address,
          })
          .getCount();

        await this.updateTokenHoldersCount(
          token,
          tokenHolderCount,
          manager,
        );
      }
    } catch (error) {
      this.logger.error('Error updating token holder', error);
      throw error;
    }

    // Background operation - keep outside transaction
    if (!manager) {
      try {
        await this.tokenService.loadAndSaveTokenHoldersFromMdw(
          token.sale_address as Encoded.ContractAddress,
        );
      } catch (error: any) {
        this.logger.error(
          `Error loading and saving token holders from mdw`,
          error,
          error.stack,
        );
      }
    }
  }
}

