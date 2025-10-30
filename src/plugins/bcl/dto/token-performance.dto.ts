import { ApiProperty } from '@nestjs/swagger';
import { PerformancePeriodDto } from './performance-period.dto';

export class TokenPerformanceDto {
  @ApiProperty()
  sale_address: string;

  @ApiProperty({ type: () => PerformancePeriodDto, nullable: true })
  past_24h: PerformancePeriodDto;

  @ApiProperty({ type: () => PerformancePeriodDto, nullable: true })
  past_7d: PerformancePeriodDto;

  @ApiProperty({ type: () => PerformancePeriodDto, nullable: true })
  past_30d: PerformancePeriodDto;

  @ApiProperty({ type: () => PerformancePeriodDto, nullable: true })
  all_time: PerformancePeriodDto;
}
