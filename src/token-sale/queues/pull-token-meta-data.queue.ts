import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Queue } from 'bull';
import { AeSdkService } from 'src/ae/ae-sdk.service';
import { TokenHistory } from 'src/tokens/entities/token-history.entity';
import { Token } from 'src/tokens/entities/token.entity';
import { TokenWebsocketGateway } from 'src/tokens/token-websocket.gateway';
import { initTokenSale } from 'token-gating-sdk';
import { Repository } from 'typeorm';
import {
  PULL_TOKEN_META_DATA_QUEUE,
  SYNC_TOKEN_HISTORY_QUEUE,
} from './constants';

export interface IPullTokenMetaDataQueue {
  saleAddress: Encoded.ContractAddress;
}

@Processor(PULL_TOKEN_META_DATA_QUEUE)
export class PullTokenMetaDataQueue {
  private readonly logger = new Logger(PullTokenMetaDataQueue.name);

  constructor(
    private aeSdkService: AeSdkService,
    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,

    @InjectRepository(TokenHistory)
    private tokenHistoriesRepository: Repository<TokenHistory>,

    @InjectQueue(SYNC_TOKEN_HISTORY_QUEUE)
    private readonly syncTokenHistoryQueue: Queue,

    private tokenWebsocketGateway: TokenWebsocketGateway,
  ) {
    //
  }

  @Process()
  async process(job: Job<IPullTokenMetaDataQueue>) {
    this.logger.log(`PullTokenMetaDataQueue->started:${job.data.saleAddress}`);
    try {
      await this.loadAndSaveTokenMetaData(job.data.saleAddress);
      this.logger.debug(
        `PullTokenMetaDataQueue->completed:${job.data.saleAddress}`,
      );
    } catch (error) {
      this.logger.error(`PullTokenMetaDataQueue->error`, error);
    }
  }

  async loadAndSaveTokenMetaData(saleAddress: Encoded.ContractAddress) {
    const tokenExists = await this.tokensRepository.findOneBy({
      sale_address: saleAddress,
    });

    if (tokenExists) {
      const hasHistory = await this.checkIfTokenHasHistory(tokenExists);
      if (!hasHistory) {
        this.logger.debug(
          'PullTokenMetaDataQueue->Token already exists but no history',
        );
      }
      void this.syncTokenHistoryQueue.add({
        saleAddress,
      });
      return;
    }

    const { instance } = await initTokenSale(
      this.aeSdkService.sdk,
      saleAddress as Encoded.ContractAddress,
    ).catch((error) => {
      this.logger.error('PullTokenMetaDataQueue->initTokenSale', error);
      return { instance: null };
    });

    if (!instance) {
      return;
    }
    const [tokenMetaInfo] = await Promise.all([
      instance.metaInfo().catch(() => {
        return { token: {} };
      }),
    ]);

    const tokensCount = await this.tokensRepository.count();

    const tokenData = {
      sale_address: saleAddress,
      ...(tokenMetaInfo?.token || {}),
      rank: tokensCount + 1,
    };

    const token = await this.tokensRepository.save(tokenData);
    // Broadcast token created
    this.tokenWebsocketGateway.handleTokenCreated({
      sale_address: saleAddress,
      data: token,
    });
    void this.syncTokenHistoryQueue.add({
      saleAddress,
    });
  }
  async checkIfTokenHasHistory(token: Token) {
    const tokenHistory = await this.tokenHistoriesRepository
      .createQueryBuilder('token_history')
      .where('token_history.tokenId = :tokenId', {
        tokenId: token.id,
      })
      .getExists();

    return tokenHistory;
  }
}
