import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TokenHistory } from './entities/token-history.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TokensService } from './tokens.service';
import { TokenHistoryService } from './token-history.service';
import moment from 'moment';

@Controller('api/historical')
@ApiTags('Historical')
export class HistoricalController {
  constructor(
    @InjectRepository(TokenHistory)
    private readonly tokenHistoryRepository: Repository<TokenHistory>,
    private readonly tokensService: TokensService,
    private readonly tokenHistoryService: TokenHistoryService,
  ) {}

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
  ) {
    const date = startDate
      ? this.parseDate(startDate)
      : moment().subtract(interval * 1000, 'seconds');
    console.log('HistoricalController->findByAddress->address', {
      address,
      interval,
      date,
      startDate,
      endDate,
    });
    const token = await this.tokensService.findByAddress(address);
    return this.tokenHistoryService.getHistoricalData({
      token,
      interval,
      startDate: date,
      endDate: this.parseDate(endDate),
      convertTo,
    });
  }

  private parseDate(value: string | number) {
    // if timestamp
    if (typeof value === 'number') {
      return moment.unix(value);
    }
    return moment(value);
  }

  private getSubtractDate(interval: string): moment.Moment {
    switch (interval) {
      case '1m':
        return moment().subtract(1, 'day');
      case '5m':
        return moment().subtract(2, 'days');
      case '15m':
        return moment().subtract(3, 'days');
      case '1h':
        return moment().subtract(7, 'days');
      case '4h':
        return moment().subtract(2, 'weeks');
      case '1d':
        return moment().subtract(1, 'month');
      case '7d':
        return moment().subtract(6, 'months');
      case '30d':
        return moment().subtract(12, 'months');
      default:
        throw new Error('Invalid interval');
    }
  }
}
