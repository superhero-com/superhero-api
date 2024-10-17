import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { TokenHolder } from 'src/tokens/entities/token-holders.entity';
import { Token } from 'src/tokens/entities/token.entity';
import { initTokenSale } from 'token-gating-sdk';
import { Repository } from 'typeorm';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './constants';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import BigNumber from 'bignumber.js';

export interface ISyncTokenHoldersQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(SYNC_TOKEN_HOLDERS_QUEUE)
export class SyncTokenHoldersQueue {
  private readonly logger = new Logger(SyncTokenHoldersQueue.name);

  constructor(
    private aeSdkService: AeSdkService,
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
      await this.loadAndSaveTokenHolders(job.data.saleAddress);
      this.logger.debug(
        `SyncTokenHoldersQueue->completed:${job.data.saleAddress}`,
      );
    } catch (error) {
      this.logger.error(`SyncTokenHoldersQueue->error`, error);
    }
  }

  async loadAndSaveTokenHolders(saleAddress: Encoded.ContractAddress) {
    const token = await this.tokensRepository.findOneBy({
      sale_address: saleAddress,
    });

    if (!token) {
      return;
    }

    // delete all previous holders
    await this.tokenHoldersRepository.delete({
      token: token,
    });

    const { instance } = await initTokenSale(
      this.aeSdkService.sdk,
      saleAddress as Encoded.ContractAddress,
    );
    const contractInstance = await instance.tokenContractInstance();

    const holders = await contractInstance
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

    await this.tokenHoldersRepository.save(
      holders.map((holder) => {
        return {
          token: token,
          ...holder,
        };
      }),
    );
  }
}
