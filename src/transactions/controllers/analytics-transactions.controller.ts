import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import moment from 'moment';
import { TokensService } from '@/tokens/tokens.service';

interface DailyVolumeResult {
  date: Date;
  volume_ae: number;
  transaction_count: number;
}

@Controller('api/analytics/transactions')
@ApiTags('Analytics')
export class AnalyticsTransactionsController {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    private readonly communityFactoryService: CommunityFactoryService,
    private tokenService: TokensService,
  ) {}

  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiQuery({ name: 'token_address', type: 'string', required: false })
  @ApiQuery({ name: 'account_address', type: 'string', required: false })
  @ApiOperation({ operationId: 'listDailyVolume' })
  @Get('daily-volume')
  async dailyVolume(
    @Query('start_date') start_date?: string,
    @Query('end_date') end_date?: string,
    @Query('token_address') token_address?: string,
    @Query('account_address') account_address?: string,
  ): Promise<DailyVolumeResult[]> {
    // If no dates provided, default to last 7 days
    const defaultStartDate = moment().subtract(7, 'days').startOf('day');
    const defaultEndDate = moment().endOf('day');

    const startDate = start_date
      ? moment(start_date).startOf('day')
      : defaultStartDate;
    const endDate = end_date ? moment(end_date).endOf('day') : defaultEndDate;

    console.log('Query parameters:', {
      start_date: startDate.format('YYYY-MM-DD'),
      end_date: endDate.format('YYYY-MM-DD'),
      token_address,
      account_address,
    });

    // First, let's check if we have any transactions in the date range
    const countQuery = this.transactionsRepository
      .createQueryBuilder('transactions')
      .where('transactions.created_at >= :start_date', {
        start_date: startDate.toDate(),
      })
      .andWhere('transactions.created_at <= :end_date', {
        end_date: endDate.toDate(),
      });

    const totalCount = await countQuery.getCount();
    console.log('Total transactions in date range:', totalCount);

    // Let's check the actual data structure
    const sampleTransactions = await this.transactionsRepository
      .createQueryBuilder('transactions')
      .select([
        'transactions.amount',
        'transactions.created_at',
        'transactions.volume',
      ])
      .limit(5)
      .getRawMany();

    console.log('Sample transactions:', sampleTransactions);

    // Build the main query
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transactions')
      .select([
        "DATE_TRUNC('day', transactions.created_at) as date",
        "COALESCE(SUM(CAST(NULLIF(transactions.amount->>'ae', 'NaN') AS DECIMAL)), 0) as volume_ae",
        'COUNT(*) as transaction_count',
      ])
      .where('transactions.created_at >= :start_date', {
        start_date: startDate.toDate(),
      })
      .andWhere('transactions.created_at <= :end_date', {
        end_date: endDate.toDate(),
      })
      .groupBy("DATE_TRUNC('day', transactions.created_at)")
      .orderBy('date', 'DESC');

    // Add token filter if provided
    if (token_address) {
      const token = await this.tokenService.getToken(token_address);
      console.log('Token filter:', token);
      if (token) {
        queryBuilder.andWhere('transactions."tokenId" = :tokenId', {
          tokenId: token.id,
        });
      }
    }

    // Add account filter if provided
    if (account_address) {
      console.log('Account filter:', account_address);
      queryBuilder.andWhere('transactions.address = :account_address', {
        account_address,
      });
    }

    return queryBuilder.getRawMany();
  }
}
