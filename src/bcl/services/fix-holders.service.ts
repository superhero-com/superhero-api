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
import { Equal, In, Not, Repository } from 'typeorm';
import { SyncedBlock } from '../entities/synced-block.entity';

@Injectable()
export class FixHoldersService {
  fixingTokens = false;
  private readonly logger = new Logger(FixHoldersService.name);

  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHolder)
    private tokenHolderRepository: Repository<TokenHolder>,

    @InjectRepository(SyncedBlock)
    private syncedBlocksRepository: Repository<SyncedBlock>,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,
  ) {
    //
  }

  onModuleInit() {
    this.syncLatestBlockCallers();
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
  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncLatestBlockCallers() {
    if (this.isSyncingBlockCallers) {
      return;
    }
    this.isSyncingBlockCallers = true;
    // get latest 20 blocks
    const blocks = await this.syncedBlocksRepository.find({
      order: {
        block_number: 'DESC',
      },
      take: 20,
    });

    // unique callers
    const callers = blocks.map((block) => block.callers).flat();
    // unique callers
    const uniqueCallers = callers;
    this.logger.log(`Syncing ${uniqueCallers.length} callers...`);
    this.logger.log('///////////////////////////////////////////////');
    this.logger.log('///////////////////////////////////////////////');
    this.logger.log('///////////////////////////////////////////////');
    this.logger.log('UNIQUE CALLERS', uniqueCallers);
    this.logger.log('///////////////////////////////////////////////');
    this.logger.log('///////////////////////////////////////////////');
    for (const caller of uniqueCallers) {
      this.logger.log('///////////////////////////////////////////////');
      this.logger.log('CALLER::', caller);
      this.logger.log('///////////////////////////////////////////////');
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
        await this.tokenHolderRepository.update(
          {
            token: { id: token.id },
            address: caller,
          },
          {
            balance: item.amount,
            block_number: item.height,
            last_tx_hash: item.tx_hash,
          },
        );
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
  @Cron(CronExpression.EVERY_30_MINUTES)
  async fixBrokenHolders() {
    if (this.fixingTokensHolders) {
      return;
    }
    this.fixingTokensHolders = true;
    this.logger.log('Fixing broken holders...');

    await this.checkTokensWithMismatchingSupply();
    this.logger.log('Fixing broken holders... done');
    this.fixingTokensHolders = false;
  }

  // check if current_supply is different from the total holders sum, if not do a holders re-sync
  async checkTokensWithMismatchingSupply() {
    const tokens = await this.tokensRepository.find({
      where: {
        total_supply: Not(Equal(0)),
      },
    });
    for (const token of tokens) {
      const holdersSum = await this.tokenHolderRepository
        .createQueryBuilder('token_holder')
        .where('token_holder.tokenId = :tokenId', { tokenId: token.id })
        .select('SUM(token_holder.balance)')
        .getRawOne()
        .then((res) => res.sum);

      const balance = token.total_supply.toNumber();
      if (holdersSum !== balance && holdersSum > 0) {
        await this.fullResyncHolders(token);
      }
    }
  }

  async fullResyncHolders(token: Token) {
    const data = await this.getAllHoldersData(token);

    if (!data?.length) {
      return;
    }

    // const addresses = data.map((item) => item.account_id);
    // delete all holders for this token
    await this.tokenHolderRepository.delete({
      // address: Not(In(addresses)),
      token: { id: token.id },
    });

    const holders = data.map((item) => ({
      address: item.account_id,
      balance: item.amount,
    }));

    // update or insert holders
    await this.tokenHolderRepository.insert(holders);

    // update token holders count
    await this.tokensRepository.update(token.id, {
      holders_count: holders.length,
    });
  }

  private async getAllHoldersData(token: Token) {
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${token.address}/balances?limit=100`;

    const holdersData = [];
    const holders = await this.getAllHoldersList(url);
    for (const holder of holders) {
      const holderUrl = `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${token.address}/balances/${holder.account_id}`;
      const data = await fetchJson(holderUrl);
      holdersData.push({
        ...holder,
        amount: data?.amount,
      });
    }

    return holdersData;
  }

  private async getAllHoldersList(url: string): Promise<any[]> {
    const mdwData = await fetchJson(url);

    if (mdwData?.next) {
      return [
        ...mdwData.data,
        ...(await this.getAllHoldersList(
          `${ACTIVE_NETWORK.middlewareUrl}${mdwData.next}`,
        )),
      ];
    }

    return mdwData?.data || [];
  }
}
