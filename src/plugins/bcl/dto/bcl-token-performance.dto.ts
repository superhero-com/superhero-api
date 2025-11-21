import { ApiProperty } from '@nestjs/swagger';
import { BclPerformancePeriodDto, BclAllTimePerformanceDto } from './bcl-performance-period.dto';

export class BclTokenPerformanceDto {
  @ApiProperty({ 
    description: 'Performance metrics for the past 24 hours',
    type: () => BclPerformancePeriodDto,
    nullable: true 
  })
  past_24h: BclPerformancePeriodDto | null;

  @ApiProperty({ 
    description: 'Performance metrics for the past 7 days',
    type: () => BclPerformancePeriodDto,
    nullable: true 
  })
  past_7d: BclPerformancePeriodDto | null;

  @ApiProperty({ 
    description: 'Performance metrics for the past 30 days',
    type: () => BclPerformancePeriodDto,
    nullable: true 
  })
  past_30d: BclPerformancePeriodDto | null;

  @ApiProperty({ 
    description: 'All-time performance metrics',
    type: () => BclAllTimePerformanceDto,
    nullable: true 
  })
  all_time: BclAllTimePerformanceDto | null;
}

