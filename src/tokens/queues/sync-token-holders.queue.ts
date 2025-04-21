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
    } catch (error) {
      this.logger.error(`SyncTokenHoldersQueue->error`, error);
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

    await this.tokenHoldersRepository.save(
      holders.map((holder) => {
        const balance = new BigNumber(holder.amount);
        return {
          token: token,
          address: holder.account_id,
          balance,
          percentage: balance
            .div(token.total_supply)
            .multipliedBy(100)
            .toNumber(),
        };
      }),
    );

    if (response.next) {
      return this.loadData(
        token,
        `${ACTIVE_NETWORK.middlewareUrl}${response.next}`,
        totalHolders + holders.length,
      );
    }

    return totalHolders + holders.length;
  }

  /**
   * @deprecated
   */
  async loadAndSaveTokenHolders(saleAddress: Encoded.ContractAddress) {
    const token = await this.tokenService.getToken(saleAddress);
    const { tokenContractInstance } =
      await this.tokenService.getTokenContractsBySaleAddress(saleAddress);

    const holders = await tokenContractInstance
      .balances()
      .then((res) => res.decodedResult)
      .then((res) => {
        return Array.from(res).map(([key, value]: any) => {
          return {
            address: key,
            balance: new BigNumber(value),
            percentage: 0,
          };
        });
      });

    // calculate each holder percentage
    const totalSupply = holders.reduce((acc, holder) => {
      return acc.plus(holder.balance);
    }, new BigNumber(0));

    holders.forEach((holder) => {
      holder.percentage = holder.balance
        .div(totalSupply)
        .multipliedBy(100)
        .toNumber();
    });

    const holders_count = holders.filter((holder) =>
      holder.balance.gt(0),
    ).length;

    await this.tokensRepository.update(token.id, {
      holders_count,
    });

    // remove all holders
    await this.tokenHoldersRepository.delete({
      token: token,
    });

    const factoryAddress = token.factory_address?.replace('ct_', 'ak_');
    await this.tokenHoldersRepository.save(
      holders
        .filter((holder) => {
          if (factoryAddress === holder.address && !holder.balance.gt(0)) {
            return false;
          }
          return true;
        })
        .map((holder) => {
          return {
            token: token,
            ...holder,
          };
        }),
    );
  }
}
