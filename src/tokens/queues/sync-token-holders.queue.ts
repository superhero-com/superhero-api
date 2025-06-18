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
  @Process({
    concurrency: 10,
  })
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
    const aex9Address =
      token?.address || (await this.tokenService.getTokenAex9Address(token));

    const totalHolders = await this._loadHoldersData(token, aex9Address);
    if (totalHolders.length > 0) {
      await this.tokenHoldersRepository.delete({
        aex9_address: aex9Address,
      });
      await this.tokenHoldersRepository.insert(totalHolders);
    }
    await this.tokensRepository.update(token.sale_address, {
      holders_count: totalHolders.length,
    });
  }

  async _loadHoldersData(token: Token, aex9Address: string) {
    const _holders = await this._loadHoldersFromContract(token, aex9Address);
    if (_holders.length > 0) {
      return _holders;
    }
    return this.loadData(
      token,
      aex9Address,
      `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${aex9Address}/balances?by=amount&limit=100`,
    );
  }

  async loadData(
    token: Token,
    aex9Address: string,
    url: string,
    totalHolders = [],
  ) {
    try {
      const response = await fetchJson(url);
      if (!response.data) {
        this.logger.error(
          `SyncTokenHoldersQueue:failed to load data from url::${url}`,
        );
        this.logger.error(`SyncTokenHoldersQueue:response::`, response);
        return totalHolders;
      }
      const holders = response.data.filter((item) => item.amount > 0);
      this.logger.debug(
        `SyncTokenHoldersQueue->holders:${holders.length}`,
        url,
      );

      for (const holder of holders) {
        try {
          const holderUrl = `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${aex9Address}/balances/${holder.account_id}`;
          const holderData = await fetchJson(holderUrl);
          if (!holderData?.amount) {
            this.logger.warn(
              `SyncTokenHoldersQueue->holderData:${holderUrl}`,
              holderData,
            );
          }
          totalHolders.push({
            id: `${holderData?.account || holder.account_id}_${aex9Address}`,
            aex9_address: aex9Address,
            address: holderData?.account || holder.account_id,
            balance: new BigNumber(holderData?.amount || 0),
          });
        } catch (error: any) {
          this.logger.error(
            `SyncTokenHoldersQueue->error:${error.message}`,
            error,
            error.stack,
          );
        }
      }

      if (response.next) {
        return this.loadData(
          token,
          aex9Address,
          `${ACTIVE_NETWORK.middlewareUrl}${response.next}`,
          totalHolders,
        );
      }

      return totalHolders;
    } catch (error: any) {
      this.logger.error(`SyncTokenHoldersQueue->error`, error, error.stack);
      return totalHolders;
    }
  }

  async _loadHoldersFromContract(token: Token, aex9Address: string) {
    try {
      const { tokenContractInstance } =
        await this.tokenService.getTokenContractsBySaleAddress(
          token.sale_address as Encoded.ContractAddress,
        );
      const holderBalances = await tokenContractInstance.balances();
      const holders = Array.from(holderBalances.decodedResult)
        .map(([key, value]: any) => ({
          id: `${key}_${aex9Address}`,
          aex9_address: aex9Address,
          address: key,
          balance: new BigNumber(value),
        }))
        .filter((item) => item.balance.gt(0))
        .sort((a, b) => b.balance.minus(a.balance).toNumber());

      return holders || [];
    } catch (error: any) {
      this.logger.error(
        `SyncTokenHoldersQueue->_loadHoldersFromContract:failed to load holders from contract`,
        error,
        error.stack,
      );
      return [];
    }
  }
}
