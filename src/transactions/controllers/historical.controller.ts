import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { TokensService } from '@/tokens/tokens.service';
import moment from 'moment';
import {
  ITransactionPreview,
  TransactionHistoryService,
} from '../services/transaction-history.service';

@Controller('tokens')
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

  @ApiOperation({ operationId: 'getPaginatedHistory' })
  @ApiQuery({
    name: 'interval',
    type: 'number',
    description: 'Interval type in seconds, default is 3600 (1 hour)',
    required: false,
  })
  @ApiQuery({
    name: 'convertTo',
    enum: ['ae', 'usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp', 'xau'],
    required: false,
  })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @CacheTTL(10)
  // @CacheTTL(1000)
  @Get(':address/history')
  async getPaginatedHistory(
    @Param('address') address: string,
    @Query('interval') interval: number = 3600,
    @Query('convertTo') convertTo: string = 'ae',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ) {
    const token = await this.tokenService.getToken(address);
    return this.tokenHistoryService.getPaginatedHistoricalData({
      token,
      interval,
      convertTo,
      page,
      limit,
    });
  }

  @ApiOperation({ operationId: 'getForPreview' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiQuery({
    name: 'interval',
    enum: ['1d', '7d', '30d'],
    required: false,
    example: '7d',
  })
  @CacheTTL(5 * 60 * 1000)
  @Get('/preview/:address')
  async getForPreview(
    @Param('address') address: string,
    @Query('interval') interval: '1d' | '7d' | '30d' = '7d',
  ): Promise<ITransactionPreview> {
    if (!address || address == 'null') {
      throw new BadRequestException('Address is required');
    }
    const token = await this.tokenService.getToken(address);
    return this.tokenHistoryService.getForPreview(token, interval);
  }

  private parseDate(value: string | number | undefined) {
    // if timestamp
    if (typeof value === 'number') {
      return moment.unix(value);
    }
    return moment(value);
  }
}
