import { ApiProperty } from '@nestjs/swagger';

export class PnlAmountDto {
  @ApiProperty({
    description: 'Amount in AE tokens',
    example: 1000.5,
  })
  ae: number;

  @ApiProperty({
    description: 'Amount in USD',
    example: 500.25,
  })
  usd: number;
}

export class TotalPnlDto {
  @ApiProperty({
    description: 'Total PNL percentage',
    example: 15.5,
  })
  percentage: number;

  @ApiProperty({
    description: 'Total amount invested',
    type: () => PnlAmountDto,
  })
  invested: PnlAmountDto;

  @ApiProperty({
    description: 'Current total value',
    type: () => PnlAmountDto,
  })
  current_value: PnlAmountDto;

  @ApiProperty({
    description: 'Total gain/loss',
    type: () => PnlAmountDto,
  })
  gain: PnlAmountDto;
}

export class TokenPnlDto {
  @ApiProperty({
    description: 'Current unit price of the token',
    type: () => PnlAmountDto,
  })
  current_unit_price: PnlAmountDto;

  @ApiProperty({
    description: 'PNL percentage for this token',
    example: 25.3,
  })
  percentage: number;

  @ApiProperty({
    description: 'Amount invested in this token',
    type: () => PnlAmountDto,
  })
  invested: PnlAmountDto;

  @ApiProperty({
    description: 'Current value of holdings',
    type: () => PnlAmountDto,
  })
  current_value: PnlAmountDto;

  @ApiProperty({
    description: 'Gain/loss for this token',
    type: () => PnlAmountDto,
  })
  gain: PnlAmountDto;
}

export class GetPnlResponseDto {
  @ApiProperty({
    description: 'Block height used for the calculation',
    example: 12345678,
  })
  block_height: number;

  @ApiProperty({
    description: 'Total PNL across all tokens',
    type: () => TotalPnlDto,
  })
  total_pnl: TotalPnlDto;

  @ApiProperty({
    description: 'PNL breakdown per token (keyed by sale_address)',
    type: 'object',
    additionalProperties: { type: 'object' },
    example: {
      'ct_2AfnEfCSPx4A6UYXj2XHDqHXcC7EF2bgbp8UN1KPAJDysPJT32': {
        current_unit_price: { ae: 0.001, usd: 0.0005 },
        percentage: 15.5,
        invested: { ae: 100, usd: 50 },
        current_value: { ae: 115.5, usd: 57.75 },
        gain: { ae: 15.5, usd: 7.75 },
      },
    },
  })
  tokens_pnl: Record<string, TokenPnlDto>;
}

