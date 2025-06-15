import { CommunityFactoryService } from '@/ae/community-factory.service';
import { SyncBlocksService } from '@/bcl/services/sync-blocks.service';
import { ACTIVE_NETWORK } from '@/configs/network';
import { Token } from '@/tokens/entities/token.entity';
import { TokensService } from '@/tokens/tokens.service';
import { TransactionService } from '@/transactions/services/transaction.service';
import { fetchJson } from '@/utils/common';
import { ICommunityFactorySchema } from '@/utils/types';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CommunityFactory } from 'bctsl-sdk';
import BigNumber from 'bignumber.js';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import moment from 'moment';
import { Repository } from 'typeorm';
import { FixHoldersService } from './fix-holders.service';

@Injectable()
export class FastPullTokensService {
  pullingTokens = false;
  factoryContract: CommunityFactory;
  private readonly logger = new Logger(FastPullTokensService.name);

  constructor(
    private readonly tokensService: TokensService,
    private communityFactoryService: CommunityFactoryService,

    private syncBlocksService: SyncBlocksService,
    private readonly transactionService: TransactionService,

    private readonly fixHoldersService: FixHoldersService,

    @InjectRepository(Token)
    private tokensRepository: Repository<Token>,
  ) {
    //
  }

  onModuleInit() {
    this.fastPullTokens();
  }

  isPullingLatestCreatedTokens = false;
  @Cron(CronExpression.EVERY_10_MINUTES)
  async pullLatestCreatedTokens() {
    if (
      this.isPullingLatestCreatedTokens ||
      !this.syncBlocksService.latestBlockNumber
    ) {
      return;
    }
    this.isPullingLatestCreatedTokens = true;
    const factory = await this.communityFactoryService.getCurrentFactory();

    const queryString = new URLSearchParams({
      direction: 'backward',
      limit: '100',
      scope: `gen:${this.syncBlocksService.latestBlockNumber - 100}-${this.syncBlocksService.latestBlockNumber}`,
      type: 'contract_call',
      contract: factory.address,
    }).toString();

    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;
    await this.loadCreatedCommunityFromMdw(url, factory);
    this.isPullingLatestCreatedTokens = false;
  }

  @Cron(CronExpression.EVERY_DAY_AT_10AM)
  async fastPullTokens() {
    if (this.pullingTokens) {
      return;
    }
    this.pullingTokens = true;

    const factory = await this.communityFactoryService.getCurrentFactory();

    const queryString = new URLSearchParams({
      direction: 'forward',
      limit: '100',
      type: 'contract_call',
      contract: factory.address,
    }).toString();
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/transactions?${queryString}`;

    const communities = await this.loadCreatedCommunityFromMdw(url, factory);

    const tokens = communities.sort((a, b) => {
      if (!a.total_supply || !b.total_supply) {
        return 0;
      }
      return b.total_supply.minus(a.total_supply).toNumber();
    });

    for (const token of tokens) {
      const liveTokenData = await this.tokensService.getTokeLivePrice(token);
      await this.tokensRepository.update(token.sale_address, liveTokenData);
      await this.fixHoldersService.syncTokenHolders(token);
    }

    this.pullingTokens = false;
  }

  /**
   * @param url
   * @param factory
   * @param saleAddresses
   * @returns
   */
  private async loadCreatedCommunityFromMdw(
    url: string,
    factory: ICommunityFactorySchema,
    tokens: Token[] = [],
  ): Promise<Token[]> {
    let totalRetries = 0;
    this.logger.log('loadCreatedCommunityFromMdw->url::', url);
    let result: any;
    try {
      result = await fetchJson(url);
    } catch (error) {
      if (totalRetries < 3) {
        totalRetries++;
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return this.loadCreatedCommunityFromMdw(url, factory, tokens);
      }
      this.logger.error('loadCreatedCommunityFromMdw->error::', error);
      return tokens;
    }

    if (result?.data?.length) {
      for (const transaction of result.data) {
        try {
          const tx = transaction.tx;
          if (
            tx.function !== 'create_community' ||
            tx?.return_type === 'revert' ||
            !tx?.return?.value?.length ||
            tx.return.value.length < 2
          ) {
            continue;
          }
          if (
            // If it's not supported collection, skip
            !Object.keys(factory.collections).includes(tx.arguments[0].value)
          ) {
            continue;
          }
          const daoAddress = tx?.return?.value[0]?.value;
          const saleAddress = tx?.return?.value[1]?.value;

          const tokenExists = await this.tokensService.findById(saleAddress);
          const tokenName = tx?.arguments?.[1]?.value;

          const decodedData = this.factoryContract?.contract?.$decodeEvents(
            tx?.log,
          );
          const tokenData = {
            total_supply: new BigNumber(0),
            holders_count: 0,
            address: null,
            dao_address: daoAddress,
            sale_address: saleAddress,
            factory_address: factory.address,
            creator_address: tx?.caller_id,
            created_at: moment(transaction?.micro_time).toDate(),
            name: tokenName,
            symbol: tokenName,
            create_tx_hash: transaction?.hash,
          };

          const fungibleToken = decodedData?.find(
            (event) =>
              event.contract.name === 'FungibleTokenFull' &&
              event.contract.address !== factory.bctsl_aex9_address,
          );
          tokenData.address =
            fungibleToken?.contract?.address || tokenExists?.address;
          if (tokenData.address) {
            const tokenDataResponse = await fetchJson(
              `${ACTIVE_NETWORK.middlewareUrl}/v3/aex9/${tokenData.address}`,
            );
            if (!tokenExists?.total_supply?.gt(0)) {
              tokenData.total_supply = new BigNumber(
                tokenDataResponse?.event_supply,
              );
            }

            tokenData.holders_count = tokenDataResponse?.holders;
          }

          let token;
          if (tokenExists?.sale_address) {
            await this.tokensRepository.update(
              tokenExists.sale_address,
              tokenData,
            );
            token = await this.tokensService.findById(tokenExists.sale_address);
          } else {
            token = await this.tokensRepository.save(tokenData);
          }
          await this.transactionService.saveTransaction(
            camelcaseKeysDeep(transaction),
            token,
          );
          tokens.push(token);
        } catch (error: any) {
          this.logger.error(
            `loadCreatedCommunityFromMdw->error:: for tx: ${transaction?.tx?.hash}`,
            error?.message,
            error?.stack,
          );
        }
      }
    } else {
      this.logger.log('loadCreatedCommunityFromMdw->no data::', url);
    }

    if (result.next) {
      return await this.loadCreatedCommunityFromMdw(
        `${ACTIVE_NETWORK.middlewareUrl}${result.next}`,
        factory,
        tokens,
      );
    }
    return tokens;
  }
}
