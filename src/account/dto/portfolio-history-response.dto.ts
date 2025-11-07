import { ApiProperty } from '@nestjs/swagger';
import { PnlAmountDto, TotalPnlDto, TokenPnlDto } from './pnl-response.dto';

export class PortfolioHistorySnapshotDto {
  @ApiProperty({
    description: 'Timestamp of the snapshot',
    type: 'string',
    format: 'date-time',
    example: '2024-01-01T00:00:00.000Z',
  })
  timestamp: Date;

  @ApiProperty({
    description: 'Block height at the time of the snapshot',
    example: 12345678,
  })
  block_height: number;

  @ApiProperty({
    description: 'Total value of tokens in AE',
    example: 1000.5,
  })
  tokens_value_ae: number;

  @ApiProperty({
    description: 'Total value of tokens in USD',
    example: 500.25,
  })
  tokens_value_usd: number;

  @ApiProperty({
    description: 'Total portfolio value in AE (AE balance + tokens value)',
    example: 2000.5,
  })
  total_value_ae: number;

  @ApiProperty({
    description: 'Total portfolio value in USD',
    example: 1000.5,
  })
  total_value_usd: number;

  @ApiProperty({
    description: 'AE balance at the time of the snapshot',
    example: 1000.0,
  })
  ae_balance: number;

  @ApiProperty({
    description: 'USD value of AE balance',
    example: 500.0,
  })
  usd_balance: number;

  @ApiProperty({
    description: 'AE price in USD at the time of the snapshot',
    example: 0.5,
  })
  ae_price: number;

  @ApiProperty({
    description: 'Version of the snapshot format',
    example: 1,
  })
  version: number;

  @ApiProperty({
    description: 'Total PNL across all tokens (included if requested)',
    type: () => TotalPnlDto,
    required: false,
  })
  total_pnl?: TotalPnlDto;

  @ApiProperty({
    description: 'PNL breakdown per token (included if requested), keyed by token sale_address',
    type: Object,
    required: false,
  })
  tokens_pnl?: Record<string, TokenPnlDto>;
}

