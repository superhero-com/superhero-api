import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import { Job } from 'bull';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Repository } from 'typeorm';
import { TokensService } from '../tokens.service';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './constants';
import { ACTIVE_NETWORK } from '@/configs';
import { fetchJson } from '@/utils/common';

export interface ISyncTokenHoldersQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(SYNC_TOKEN_HOLDERS_QUEUE)
export class SyncTokenHoldersQueue {
  private readonly logger = new Logger(SyncTokenHoldersQueue.name);

  constructor(
    private tokenService: TokensService,
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHolder)
    private tokenHoldersRepository: Repository<TokenHolder>,
  ) {
    //
  }

  /**
   * @param job
   */
  @Process()
  async process(job: Job<ISyncTokenHoldersQueue>) {
    this.logger.log(`SyncTokenHoldersQueue->started:${job.data.saleAddress}`);
    try {
      await this.loadAndSaveTokenHoldersFromMdw(job.data.saleAddress);
      this.logger.debug(
        `SyncTokenHoldersQueue->completed:${job.data.saleAddress}`,
      );
    } catch (error: any) {
      this.logger.error(`SyncTokenHoldersQueue->error`, error);
      this.logger.error(`SyncTokenHoldersQueue->error:stack::`, error.stack);
    }
  }

  async loadAndSaveTokenHoldersFromMdw(saleAddress: Encoded.ContractAddress) {
    const token = await this.tokenService.getToken(saleAddress);
    await this.tokenHoldersRepository.delete({
      token: token,
    });
    const totalHolders = await this.loadData(
      token,
      `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${token.address}/balances?by=amount&limit=100`,
    );
    await this.tokensRepository.update(token.id, {
      holders_count: totalHolders,
    });
  }

  async loadData(token: Token, url: string, totalHolders = 0) {
    const response = await fetchJson(url);
    const holders = response.data.filter((item) => item.amount > 0);
    this.logger.debug(`SyncTokenHoldersQueue->holders:${holders.length}`, url);

    for (const holder of holders) {
      try {
        const holderData = await fetchJson(
          `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${token.address}/balances/${holder.account_id}`,
        );
        await this.tokenHoldersRepository.save({
          token: token,
          address: holder.account_id,
          balance: new BigNumber(holderData.amount),
        });
      } catch (error) {
        //
      }
    }

    if (response.next) {
      return this.loadData(
        token,
        `${ACTIVE_NETWORK.middlewareUrl}${response.next}`,
        totalHolders + holders.length,
      );
    }

    return totalHolders + holders.length;
  }
}
