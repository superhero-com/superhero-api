import { ApiProperty } from '@nestjs/swagger';
import { PnlAmountDto } from './pnl-response.dto';

export class TradingStatsResponseDto {
  @ApiProperty({
    description: 'Largest single realized gain from any sell in the date range',
    type: () => PnlAmountDto,
  })
  top_win: PnlAmountDto;

  @ApiProperty({
    description:
      'Current unrealized profit across all tokens still held (all-time holdings, not date-filtered)',
    type: () => PnlAmountDto,
  })
  unrealized_profit: PnlAmountDto;

  @ApiProperty({
    description:
      'Percentage of sell transactions in the range that produced a positive gain',
    example: 66.7,
  })
  win_rate: number;

  @ApiProperty({
    description:
      'Average holding duration in seconds from first buy to sell (across sells in the range)',
    example: 259200,
  })
  avg_duration_seconds: number;

  @ApiProperty({
    description: 'Total number of sell transactions in the date range',
    example: 6,
  })
  total_trades: number;

  @ApiProperty({
    description: 'Number of sell transactions that produced a positive gain',
    example: 4,
  })
  winning_trades: number;
}
