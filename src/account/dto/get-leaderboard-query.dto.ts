import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  LeaderboardSortBy,
  LeaderboardSortDir,
  LeaderboardTimeUnit,
  LeaderboardWindow,
} from '../services/leaderboard.types';

const WINDOWS: LeaderboardWindow[] = ['7d', '30d', 'all'];
const SORT_BYS: LeaderboardSortBy[] = ['pnl', 'roi', 'mdd', 'aum'];
const SORT_DIRS: LeaderboardSortDir[] = ['ASC', 'DESC'];
const TIME_UNITS: LeaderboardTimeUnit[] = ['minutes', 'hours'];

export class GetLeaderboardQueryDto {
  @ApiPropertyOptional({ enum: WINDOWS, example: '7d' })
  @IsOptional()
  @IsIn(WINDOWS)
  window?: LeaderboardWindow;

  @ApiPropertyOptional({ enum: SORT_BYS, example: 'pnl' })
  @IsOptional()
  @IsIn(SORT_BYS)
  sortBy?: LeaderboardSortBy;

  @ApiPropertyOptional({
    enum: SORT_DIRS,
    example: 'DESC',
    description:
      'Defaults to DESC, except for sortBy=mdd which defaults to ASC.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(SORT_DIRS)
  sortDir?: LeaderboardSortDir;

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 18, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    example: 1,
    minimum: 0,
    description: 'Exclude leaders with AUM below this USD value.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minAumUsd?: number;

  @ApiPropertyOptional({
    example: 30,
    minimum: 1,
    description:
      'Optional rolling performance period. Must be provided together with timeUnit.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  timePeriod?: number;

  @ApiPropertyOptional({
    enum: TIME_UNITS,
    example: 'minutes',
    description:
      'Unit for timePeriod. Ranks leaders by performance over the last N minutes or hours.',
  })
  @IsOptional()
  @IsIn(TIME_UNITS)
  timeUnit?: LeaderboardTimeUnit;

  @ApiPropertyOptional({
    example: 30,
    description: 'Approximate number of sparkline points (currently ignored).',
    deprecated: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  points?: number;

  @ApiPropertyOptional({
    example: 36,
    description:
      'Upper bound of candidate addresses to evaluate (ignored in snapshot mode).',
    deprecated: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxCandidates?: number;
}
