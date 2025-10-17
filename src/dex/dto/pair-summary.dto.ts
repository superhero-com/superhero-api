import { IPriceDto, PriceDto } from '@/tokens/dto/price.dto';
import { ApiProperty } from '@nestjs/swagger';

export class PriceChangeData {
  @ApiProperty({
    description: 'Price change percentage',
    example: '5.25',
  })
  percentage: string;

  @ApiProperty({
    description: 'Price change value',
    example: '0.000123',
  })
  value: string;
}

export class PeriodData {
  @ApiProperty({
    description: 'Volume data for the period',
    type: () => PriceDto,
  })
  volume: IPriceDto;

  @ApiProperty({
    description: 'Price change data for the period',
    type: () => PriceChangeData,
  })
  price_change: PriceChangeData;
}

export class ChangeData {
  @ApiProperty({
    description: 'Data for different time periods (24h, 7d, 30d)',
    type: () => PeriodData,
  })
  '24h': PeriodData;

  @ApiProperty({
    description: 'Data for 7 days',
    type: () => PeriodData,
  })
  '7d': PeriodData;

  @ApiProperty({
    description: 'Data for 30 days',
    type: () => PeriodData,
  })
  '30d': PeriodData;
}

export class PairSummaryDto {
  @ApiProperty({
    description: 'Pair contract address',
    example: 'ct_2AfnEfCSPx4A6VjMBfDfqHNYcqDJjuJjGV1qhqP5qNKNBvYfE2',
  })
  address: string;

  @ApiProperty({
    description: 'Token used for volume calculations',
    example: 'ct_J3zBY8xxjsRr3QojETNw48Eb38fjvEuJKkQ6KzECvubvEcvCa',
  })
  volume_token: string;

  @ApiProperty({
    description: 'Token position in pair (0 or 1)',
    example: '0',
  })
  token_position: string;

  @ApiProperty({
    description: 'Total volume data',
    type: () => PriceDto,
  })
  total_volume: IPriceDto;

  @ApiProperty({
    description: 'Data for different time periods (24h, 7d, 30d)',
    type: () => ChangeData,
  })
  change: {
    '24h': PeriodData;
    '7d': PeriodData;
    '30d': PeriodData;
  };
}
