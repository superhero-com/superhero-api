import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminApiKeyGuard } from '@/api-core/guards/admin-api-key.guard';
import { FailedTransaction } from '../entities/failed-transaction.entity';

@Controller('debug')
@UseGuards(AdminApiKeyGuard)
export class DebugFailedTransactionsController {
  constructor(
    @InjectRepository(FailedTransaction)
    private failedTransactionsRepository: Repository<FailedTransaction>,
  ) {
    //
  }

  @Get('failed-transactions')
  async getFailedTransactions() {
    const failedTransactions = await this.failedTransactionsRepository.find({
      order: { created_at: 'DESC' },
      take: 500,
    });
    return failedTransactions;
  }
}
