import { ACTIVE_NETWORK } from '@/configs/network';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { SYNC_TOKEN_HOLDERS_QUEUE } from '@/tokens/queues/constants';
import { fetchJson } from '@/utils/common';
import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';

@Injectable()
export class FixHoldersService {
  fixingTokens = false;
  private readonly logger = new Logger(FixHoldersService.name);

  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHolder)
    private tokenHolderRepository: Repository<TokenHolder>,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,
  ) {
    //
  }

  onModuleInit() {
    this.fixBrokenHolders();
  }

  async syncTokenHolders(token: Token) {
    await this.syncTokenHoldersQueue.add(
      {
        saleAddress: token.sale_address,
      },
      {
        jobId: `syncTokenHolders-${token.sale_address}`,
        removeOnComplete: true,
      },
    );
  }

  isSyncingBlockCallers = false;
  async syncLatestBlockCallers(callers: string[] = []) {
    if (this.isSyncingBlockCallers) {
      return;
    }
    this.isSyncingBlockCallers = true;

    this.logger.log(`Syncing ${callers.length} callers...`);
    for (const caller of callers) {
      try {
        const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/accounts/${caller}/aex9/balances?limit=100`;
        await this.pullAndUpdateAccountAex9Balances(url, caller);
      } catch (error: any) {
        this.logger.error(
          `Error syncing block callers for ${caller}`,
          error,
          error.stack,
        );
      }
    }
    this.isSyncingBlockCallers = false;
  }

  private async pullAndUpdateAccountAex9Balances(url: string, caller: string) {
    const mdwResponse = await fetchJson(url);

    for (const item of mdwResponse.data) {
      try {
        const token = await this.tokensRepository.findOne({
          where: {
            address: item.contract_id,
          },
        });
        if (!token) {
          continue;
        }
        const holder = await this.tokenHolderRepository.findOne({
          where: {
            aex9_address: token.address,
            address: caller,
          },
        });
        if (!holder) {
          await this.tokenHolderRepository.save({
            id: `${caller}_${token.address}`,
            aex9_address: token.address,
            address: caller,
            balance: item.amount,
            block_number: item.height,
            last_tx_hash: item.tx_hash,
          });
        } else {
          await this.tokenHolderRepository.update(holder.id, {
            balance: item.amount,
            block_number: item.height,
            last_tx_hash: item.tx_hash,
          });
        }
      } catch (error: any) {
        this.logger.error(
          `Error pulling and updating account aex9 balances for ${caller}`,
          error,
          error.stack,
        );
      }
    }

    if (mdwResponse?.next) {
      await this.pullAndUpdateAccountAex9Balances(
        `${ACTIVE_NETWORK.middlewareUrl}${mdwResponse.next}`,
        caller,
      );
    }

    this.logger.log(`Pulled ${mdwResponse.data.length} tokens for ${caller}`);
  }

  fixingTokensHolders = false;
  // auto fix job, that will search for all tokens that have 0 holders and double-check them
  @Cron(CronExpression.EVERY_5_MINUTES)
  async fixBrokenHolders() {
    if (this.fixingTokensHolders) {
      return;
    }
    this.fixingTokensHolders = true;
    this.logger.log('Fixing broken holders...');

    await this.checkTokensWithoutHolders();
    this.logger.log('Fixing broken holders... done');
    this.fixingTokensHolders = false;
  }

  async checkTokensWithoutHolders() {
    const tokens = await this.tokensRepository
      .createQueryBuilder('token')
      .where('token.holders_count = :holdersCount', { holdersCount: 0 })
      .orderBy('token.total_supply', 'DESC')
      .take(20)
      .getMany();
    for (const token of tokens) {
      await this.syncTokenHolders(token);
    }
  }
}
