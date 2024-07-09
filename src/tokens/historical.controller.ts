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
    enum: ['1m', '1h', '3h', '1d', '7d', '30d'],
    required: false,
  })
  @ApiQuery({
    name: 'convertTo',
    enum: ['ae', 'usd', 'eur', 'aud', 'brl', 'cad', 'chf', 'gbp', 'xau'],
    required: false,
  })
  // startDate
  @ApiQuery({ name: 'start_date', type: 'string', required: false })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @Get(':address')
  async findByAddress(
    @Param('address') address: string,
    @Query('interval') interval: string = '3h',
    @Query('start_date') startDate: string = undefined,
    @Query('convertTo') convertTo: string = 'ae',
  ) {
    const date = startDate ? moment(startDate) : this.getSubtractDate(interval);
    const token = await this.tokensService.findByAddress(address);
    return this.tokenHistoryService.getHistoricalData({
      token,
      interval,
      startDate: date,
      endDate: moment(),
      convertTo,
    });
  }

  private getSubtractDate(interval: string): moment.Moment {
    switch (interval) {
      case '1m':
        return moment().subtract(4, 'hours');
      case '1h':
        return moment().subtract(7, 'days');
      case '3h':
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
