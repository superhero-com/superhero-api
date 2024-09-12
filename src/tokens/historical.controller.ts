import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TokenHistory } from './entities/token-history.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TokensService } from './tokens.service';
import {
  ITokenHistoryPreview,
  TokenHistoryService,
} from './token-history.service';
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
    const token = await this.tokensService.findByAddress(address);
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
  ): Promise<ITokenHistoryPreview> {
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
