import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Controller, Get, Param, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import moment from 'moment';
import { TokensService } from '@/tokens/tokens.service';
import {
  ITransactionPreview,
  TransactionHistoryService,
} from '../services/transaction-history.service';

@Controller('api/tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('Transaction Historical')
export class HistoricalController {
  constructor(
    private tokenService: TokensService,
    private readonly tokenHistoryService: TransactionHistoryService,
  ) {
    //
  }

  @ApiOperation({ operationId: 'findByAddress' })
  @ApiQuery({
    name: 'interval',
    type: 'number',
    description: 'Interval in seconds',
    required: false,
  })
  @ApiQuery({
    name: 'convertTo',
    enum: ['ae', 'usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp', 'xau'],
    required: false,
  })
  @ApiQuery({
    name: 'mode',
    enum: ['normal', 'aggregated'],
    required: false,
  })
  // startDate
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @CacheTTL(1000)
  @Get(':address/transactions')
  async findByAddress(
    @Param('address') address: string,
    @Query('interval') interval: number = 60 * 60,
    @Query('start_date') startDate: string = undefined,
    @Query('end_date') endDate: string = undefined,
    @Query('convertTo') convertTo: string = 'ae',
    @Query('mode') mode: 'normal' | 'aggregated' = 'aggregated',
  ) {
    const newStartDate = startDate
      ? this.parseDate(startDate)
      : moment().subtract(2, 'days');
    const token = await this.tokenService.getToken(address);
    return this.tokenHistoryService.getHistoricalData({
      token,
      interval,
      startDate: newStartDate,
      endDate: this.parseDate(endDate),
      convertTo,
      mode,
    });
  }

  @ApiOperation({ operationId: 'getForPreview' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @CacheTTL(5 * 60 * 1000)
  @Get('/preview/:address')
  async getForPreview(
    @Param('address') address: string,
  ): Promise<ITransactionPreview> {
    const oldestInfo =
      await this.tokenHistoryService.getOldestHistoryInfo(address);
    return this.tokenHistoryService.getForPreview(oldestInfo);
  }

  private parseDate(value: string | number | undefined) {
    // if timestamp
    if (typeof value === 'number') {
      return moment.unix(value);
    }
    return moment(value);
  }
}
