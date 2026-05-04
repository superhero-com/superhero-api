import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsISO8601, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  LeaderboardSortBy,
  LeaderboardSortDir,
  LeaderboardWindow,
} from '../services/leaderboard.types';

const WINDOWS: LeaderboardWindow[] = ['7d', '30d', 'all'];
const SORT_BYS: LeaderboardSortBy[] = ['pnl', 'roi', 'mdd', 'aum'];
const SORT_DIRS: LeaderboardSortDir[] = ['ASC', 'DESC'];

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
    example: '2026-05-04T10:00:00.000Z',
    description:
      'Optional absolute period start. Must be provided together with endDate.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-05-04T18:00:00.000Z',
    description:
      'Optional absolute period end. Must be provided together with startDate.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;

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
