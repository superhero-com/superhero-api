import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Query,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { TokensService } from '@/tokens/tokens.service';
import { buildSparklineSvg, sparklineStroke } from '@/utils/sparkline.util';
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
  @CacheTTL(60_000)
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
  @CacheTTL(5_000)
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
    enum: ['1d', '7d', '30d', '90d', '180d', 'all-time'],
    required: false,
    example: '7d',
  })
  @CacheTTL(5_000)
  @Get('/preview/:address')
  async getForPreview(
    @Param('address') address: string,
    @Query('interval')
    interval: '1d' | '7d' | '30d' | '90d' | '180d' | 'all-time' = '7d',
  ): Promise<ITransactionPreview> {
    if (!address || address == 'null') {
      throw new BadRequestException('Address is required');
    }
    const token = await this.tokenService.getToken(address);
    return this.tokenHistoryService.getForPreview(token, interval);
  }

  @ApiOperation({ operationId: 'getSparklineSvg' })
  @ApiParam({
    name: 'address',
    type: 'string',
    description: 'Token address or name',
  })
  @ApiQuery({
    name: 'interval',
    enum: ['1d', '7d', '30d', '90d', '180d', 'all-time'],
    required: false,
    example: '7d',
  })
  @ApiQuery({ name: 'width', type: 'number', required: false, example: 160 })
  @ApiQuery({ name: 'height', type: 'number', required: false, example: 60 })
  @ApiQuery({
    name: 'background',
    type: 'string',
    required: false,
    example: 'none',
    description: 'CSS fill for background rect, e.g. "#f5f5f5" or "none"',
  })
  @Header('Content-Type', 'image/svg+xml')
  @Header('Content-Disposition', 'inline; filename="sparkline.svg"')
  @CacheTTL(60_000)
  @Get('/preview/:address/sparkline.svg')
  async getSparklineSvg(
    @Param('address') address: string,
    @Query('interval')
    interval: '1d' | '7d' | '30d' | '90d' | '180d' | 'all-time' = '7d',
    @Query('width') width = '160',
    @Query('height') height = '60',
    @Query('background') background = 'none',
  ): Promise<StreamableFile> {
    if (!address || address === 'null') {
      throw new BadRequestException('Address is required');
    }
    const token = await this.tokenService.getToken(address);
    const preview = await this.tokenHistoryService.getForPreview(
      token,
      interval,
    );

    const values = preview.result.map((item) => Number(item.last_price));

    const svg = buildSparklineSvg(
      values,
      Number(width),
      Number(height),
      sparklineStroke(values),
      background,
    );

    return new StreamableFile(Buffer.from(svg), {
      type: 'image/svg+xml',
      disposition: 'inline; filename="sparkline.svg"',
    });
  }

  private parseDate(value: string | number | undefined) {
    // if timestamp
    if (typeof value === 'number') {
      return moment.unix(value);
    }
    return moment(value);
  }
}
