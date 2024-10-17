import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import moment from 'moment';
import { TokensService } from 'src/tokens/tokens.service';
import {
  ITransactionPreview,
  TransactionHistoryService,
} from '../services/transaction-history.service';

@Controller('api/historical')
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
    // enum: ['1m', '1h', '3h', '1d', '7d', '30d'],
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
  @Get(':address')
  async findByAddress(
    @Param('address') address: string,
    @Query('interval') interval: number = 60 * 60,
    @Query('start_date') startDate: string = undefined,
    @Query('end_date') endDate: string = undefined,
    @Query('convertTo') convertTo: string = 'ae',
    @Query('mode') mode: 'normal' | 'aggregated' = 'aggregated',
  ) {
    const subtract = interval * 1000;
    console.log(
      'subtract',
      subtract,
      moment().subtract(subtract, 'seconds').fromNow(),
    );
    const newStartDate = startDate
      ? this.parseDate(startDate)
      : moment().subtract(2, 'days');
    console.log('HistoricalController->findByAddress->address', {
      address,
      interval,
      newStartDate,
      startDate,
      endDate,
    });
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
