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
  @CacheTTL(5)
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
  @CacheTTL(5)
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
  @CacheTTL(60)
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

    const COLOR_UP = '#2EB88A';
    const COLOR_DOWN = '#E14E4E';
    const stroke =
      values.length >= 2 && values[values.length - 1] >= values[0]
        ? COLOR_UP
        : COLOR_DOWN;

    const svg = this.buildSparklineSvg(
      values,
      Number(width),
      Number(height),
      stroke,
      background,
    );

    return new StreamableFile(Buffer.from(svg), {
      type: 'image/svg+xml',
      disposition: 'inline; filename="sparkline.svg"',
    });
  }

  private buildSparklineSvg(
    values: number[],
    width: number,
    height: number,
    stroke: string,
    background: string,
  ): string {
    const pad = 4;
    const w = width;
    const h = height;

    if (!values.length) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const n = values.length;

    const points = values.map((v, i) => {
      const x = (i / (n - 1 || 1)) * w;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return [x, y] as [number, number];
    });

    const d = points
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
      .join(' ');

    const bg =
      background !== 'none'
        ? `<rect width="${w}" height="${h}" fill="${background}" />`
        : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">${bg}<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  private parseDate(value: string | number | undefined) {
    // if timestamp
    if (typeof value === 'number') {
      return moment.unix(value);
    }
    return moment(value);
  }
}
