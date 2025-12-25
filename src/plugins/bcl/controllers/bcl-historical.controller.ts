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
import moment from 'moment';

import { BclTransactionHistoryService } from '../services/bcl-transaction-history.service';

@Controller('bcl/tokens')
@UseInterceptors(CacheInterceptor)
@ApiTags('BCL Transaction Historical')
export class BclHistoricalController {
  constructor(
    private readonly bclTransactionHistoryService: BclTransactionHistoryService,
  ) {}

  @ApiOperation({ operationId: 'findBclHistoryByAddress' })
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
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiQuery({ name: 'end_date', type: 'string', required: false })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'BCL token sale address, token address, name, or symbol',
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

    const tokenEntity = await this.bclTransactionHistoryService.getTokenByAddress(
      address,
    );
    if (!tokenEntity) {
      throw new BadRequestException('Address is required');
    }

    return this.bclTransactionHistoryService.getHistoricalData({
      token: {
        sale_address: tokenEntity.sale_address,
        symbol: tokenEntity.symbol,
      },
      interval,
      startDate: newStartDate,
      endDate: this.parseDate(endDate),
      convertTo,
      mode,
    });
  }

  @ApiOperation({ operationId: 'getBclPaginatedHistory' })
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
    description: 'BCL token sale address, token address, name, or symbol',
  })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @CacheTTL(5)
  @Get(':address/history')
  async getPaginatedHistory(
    @Param('address') address: string,
    @Query('interval') interval: number = 3600,
    @Query('convertTo') convertTo: string = 'ae',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ) {
    const tokenEntity = await this.bclTransactionHistoryService.getTokenByAddress(
      address,
    );
    if (!tokenEntity) {
      throw new BadRequestException('Address is required');
    }

    return this.bclTransactionHistoryService.getPaginatedHistoricalData({
      token: {
        sale_address: tokenEntity.sale_address,
        symbol: tokenEntity.symbol,
      },
      interval,
      convertTo,
      page,
      limit,
    });
  }

  @ApiOperation({ operationId: 'getBclForPreview' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'BCL token sale address, token address, name, or symbol',
  })
  @ApiQuery({
    name: 'interval',
    enum: ['1d', '7d', '30d'],
    required: false,
    example: '7d',
  })
  @CacheTTL(5)
  @Get(':address/history/preview')
  async getForPreview(
    @Param('address') address: string,
    @Query('interval') interval: '1d' | '7d' | '30d' = '7d',
  ) {
    if (!address || address === 'null') {
      throw new BadRequestException('Address is required');
    }
    const tokenEntity = await this.bclTransactionHistoryService.getTokenByAddress(
      address,
    );
    if (!tokenEntity) {
      throw new BadRequestException('Address is required');
    }

    return this.bclTransactionHistoryService.getForPreview(
      {
        sale_address: tokenEntity.sale_address,
        symbol: tokenEntity.symbol,
      },
      interval,
    );
  }

  private parseDate(value: string | number | undefined) {
    if (typeof value === 'number') {
      return moment.unix(value);
    }
    return moment(value);
  }
}


