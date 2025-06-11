import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FailedTransaction } from '../entities/failed-transaction.entity';

@Controller('api/debug')
export class DebugFailedTransactionsController {
  constructor(
    @InjectRepository(FailedTransaction)
    private failedTransactionsRepository: Repository<FailedTransaction>,
  ) {
    //
  }

  @Get('failed-transactions')
  async getFailedTransactions() {
    const failedTransactions = await this.failedTransactionsRepository.find();
    return failedTransactions;
  }
}
