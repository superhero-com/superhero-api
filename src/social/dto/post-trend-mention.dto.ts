import { ApiProperty } from '@nestjs/swagger';
import { PerformancePeriodDto } from '@/tokens/dto/performance-period.dto';

export class TrendPerformanceSummaryDto {
  @ApiProperty({ type: () => PerformancePeriodDto, nullable: true })
  past_24h: PerformancePeriodDto | null;

  @ApiProperty({ type: () => PerformancePeriodDto, nullable: true })
  past_7d: PerformancePeriodDto | null;
}

export class PostTrendMentionDto {
  @ApiProperty({
    description: 'Trend name extracted from #trendName',
    example: 'SUPER',
  })
  name: string;

  @ApiProperty({
    description: 'Token sale address, if resolved',
    nullable: true,
  })
  sale_address?: string | null;

  @ApiProperty({
    description: 'Performance summary for 24h and 7d windows',
    type: () => TrendPerformanceSummaryDto,
    nullable: true,
  })
  performance?: TrendPerformanceSummaryDto | null;
}
