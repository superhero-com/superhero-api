import { IPriceDto, PriceDto } from '@/tokens/dto/price.dto';
import { ApiProperty } from '@nestjs/swagger';

export class DexTokenPeriodData {
  @ApiProperty({
    description: 'Volume data for the period',
    type: () => PriceDto,
  })
  volume: IPriceDto;

  @ApiProperty({ description: 'Price change percentage', example: '5.25' })
  percentage: string;
}

export class DexTokenChangeData {
  @ApiProperty({
    description: 'Data for 24 hours',
    type: () => DexTokenPeriodData,
  })
  '24h': DexTokenPeriodData;

  @ApiProperty({
    description: 'Data for 7 days',
    type: () => DexTokenPeriodData,
  })
  '7d': DexTokenPeriodData;

  @ApiProperty({
    description: 'Data for 30 days',
    type: () => DexTokenPeriodData,
  })
  '30d': DexTokenPeriodData;
}

export class DexTokenSummaryDto {
  @ApiProperty({ description: 'Token contract address' })
  address: string;

  @ApiProperty({ description: 'Total volume data', type: () => PriceDto })
  total_volume: IPriceDto;

  @ApiProperty({
    description: 'Data for different time periods (24h, 7d, 30d)',
    type: () => DexTokenChangeData,
    nullable: true,
  })
  change: DexTokenChangeData;
}
