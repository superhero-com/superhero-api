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
    @Query('interval') interval: string = '1m',
    @Query('start_date') startDate: string = undefined,
    @Query('convertTo') convertTo: string = 'ae',
  ) {
    const date = startDate ? moment(startDate) : moment().subtract(1, 'month');
    const token = await this.tokensService.findByAddress(address);
    return this.tokenHistoryService.getHistoricalData({
      token,
      interval,
      startDate: date,
      endDate: moment(),
      convertTo,
    });
  }
}
