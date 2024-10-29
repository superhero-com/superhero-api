import { Encoded } from '@aeternity/aepp-sdk';
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Token } from 'src/tokens/entities/token.entity';
import { In, Not, Repository } from 'typeorm';
import { DELETE_OLD_TOKENS_QUEUE } from './constants';

export interface IRemoveOldTokensQueue {
  factories: Encoded.ContractAddress[];
}

@Processor(DELETE_OLD_TOKENS_QUEUE)
export class RemoveOldTokensQueue {
  private readonly logger = new Logger(RemoveOldTokensQueue.name);
  constructor(
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
  ) {
    //
  }

  @Process()
  async process(job: Job<IRemoveOldTokensQueue>) {
    this.logger.log(`RemoveOldTokensQueue->started`);
    try {
      const factories = job.data.factories;
      this.tokensRepository
        .createQueryBuilder()
        .where({
          factory_address: Not(In(factories)),
        })
        .delete()
        .execute();
      this.logger.debug(`RemoveOldTokensQueue->completed`);
    } catch (error) {
      this.logger.error(`RemoveOldTokensQueue->error`, error);
    }
  }
}
