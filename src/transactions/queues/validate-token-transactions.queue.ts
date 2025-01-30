import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { fetchJson } from 'src/ae/utils/common';
import { ITransaction } from 'src/ae/utils/types';
import { ACTIVE_NETWORK } from 'src/configs';
import { Token } from 'src/tokens/entities/token.entity';
import { TokensService } from 'src/tokens/tokens.service';
import { In, Not, Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import { TransactionService } from '../services/transaction.service';
import { VALIDATE_TOKEN_TRANSACTIONS_QUEUE } from './constants';

export interface IValidateTokenTransactionsQueue {
  from: number; // Block height
  to: number;
  tokenId: number;
}

@Processor(VALIDATE_TOKEN_TRANSACTIONS_QUEUE)
export class ValidateTokenTransactionsQueue {
  private readonly logger = new Logger(ValidateTokenTransactionsQueue.name);
  validated_hashes: string[] = [];
  constructor(
    private transactionService: TransactionService,
    private tokenService: TokensService,

    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
  ) {
    //
  }

  /**
   * Processes a job to validate token transactions within a specified block height range.
   *
   * @param job - The job containing data for validating token transactions.
   * @param job.data.from - The starting block height for validation.
   * @param job.data.to - The ending block height for validation.
   * @param job.data.tokenId - The ID of the token to validate.
   *
   * Logs the start of the validation process, retrieves the token, validates its history,
   * and deletes unverified transactions within the specified block height range that are not in the list of validated hashes.
   *
   * @throws Will log an error if the validation process fails.
   */
  @Process()
  async process(job: Job<IValidateTokenTransactionsQueue>) {
    this.logger.log(
      `ValidateTokenTransactionsQueue->started:from:${job.data.from} - to:${job.data.to}`,
    );
    try {
      const token = await this.tokenService.findOne(job.data.tokenId);
      if (!token) {
        this.logger.error(
          `ValidateTokenTransactionsQueue->token not found:${job.data.tokenId}`,
        );
        return;
      }
      await this.validateTokenHistory(token, job);

      await this.transactionRepository
        .createQueryBuilder('transactions')
        .where('transactions.tokenId = :tokenId', {
          tokenId: token.id,
        })
        .andWhere('transactions.block_height >= :from', { from: job.data.from })
        .andWhere('transactions.block_height <= :to', { to: job.data.to })
        .andWhere('transactions.verified = false')
        .andWhere({
          tx_hash: Not(In(this.validated_hashes)),
        })
        .delete()
        .execute();
    } catch (error) {
      this.logger.error(`ValidateTokenTransactionsQueue->error`, error);
    }
  }

  async validateTokenHistory(
    token: Token,
    job: Job<IValidateTokenTransactionsQueue>,
  ) {
    this.logger.debug(
      `ValidateTokenTransactionsQueue->validateTokenHistory:${token.address}`,
    );
    const query: Record<string, string | number> = {
      direction: 'forward',
      limit: 100,
      type: 'contract_call',
      contract: token.sale_address,
      scope: `gen:${job.data.from}-${job.data.to}`,
    };

    const queryString = Object.keys(query)
      .map((key) => key + '=' + query[key])
      .join('&');

    const url = `${ACTIVE_NETWORK.middlewareUrl}/v2/txs?${queryString}`;
    await this.fetchAndValidateTransactions(token, url);
  }

  async fetchAndValidateTransactions(token: Token, url: string) {
    this.logger.debug(
      `ValidateTokenTransactionsQueue->fetchAndValidateTransactions: ${url}`,
    );
    const response = await fetchJson(url);

    await Promise.all(
      response.data
        .map((item: ITransaction) => camelcaseKeysDeep(item))
        .map((item: ITransaction) => {
          this.validated_hashes.push(item.hash);
          return this.transactionService.saveTransaction(
            item,
            token,
            false,
            true,
          );
        }),
    );

    if (response.next) {
      return this.fetchAndValidateTransactions(
        token,
        `${ACTIVE_NETWORK.middlewareUrl}${response.next}`,
      );
    }

    return null;
  }
}
