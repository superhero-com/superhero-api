import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';
import {
  POPULAR_RANKING_WEIGHT_SCALES,
  type PopularRankingWeightScale,
} from '@/configs/constants';
import type { PopularWindow } from '../services/popular-ranking.service';

export class PopularPostsQueryDto {
  @ApiPropertyOptional({
    enum: ['24h', '7d', 'all'],
    description: 'Popular ranking time window',
    default: '24h',
  })
  @IsOptional()
  @IsIn(['24h', '7d', 'all'])
  window?: PopularWindow = '24h';

  @ApiPropertyOptional({
    type: Number,
    description: 'Page number',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({
    type: Number,
    description: 'Page size',
    default: 50,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 50;

  @ApiPropertyOptional({
    type: Number,
    description: 'Return debug info when set to 1',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  debug?: number;

  @ApiPropertyOptional({
    enum: POPULAR_RANKING_WEIGHT_SCALES,
    description:
      'Scale for comment impact (low = reduce, med = default, high = boost)',
  })
  @IsOptional()
  @IsIn(POPULAR_RANKING_WEIGHT_SCALES)
  comments?: PopularRankingWeightScale;

  @ApiPropertyOptional({
    enum: POPULAR_RANKING_WEIGHT_SCALES,
    description:
      'Scale for tipped amount impact (low = reduce, med = default, high = boost)',
  })
  @IsOptional()
  @IsIn(POPULAR_RANKING_WEIGHT_SCALES)
  tipsAmountAE?: PopularRankingWeightScale;

  @ApiPropertyOptional({
    enum: POPULAR_RANKING_WEIGHT_SCALES,
    description:
      'Scale for tip count impact (low = reduce, med = default, high = boost)',
  })
  @IsOptional()
  @IsIn(POPULAR_RANKING_WEIGHT_SCALES)
  tipsCount?: PopularRankingWeightScale;

  @ApiPropertyOptional({
    enum: POPULAR_RANKING_WEIGHT_SCALES,
    description:
      'Scale for unique tippers impact (low = reduce, med = default, high = boost)',
  })
  @IsOptional()
  @IsIn(POPULAR_RANKING_WEIGHT_SCALES)
  uniqueTippers?: PopularRankingWeightScale;

  @ApiPropertyOptional({
    enum: POPULAR_RANKING_WEIGHT_SCALES,
    description:
      'Scale for trending topic boost (low = reduce, med = default, high = boost)',
  })
  @IsOptional()
  @IsIn(POPULAR_RANKING_WEIGHT_SCALES)
  trendingBoost?: PopularRankingWeightScale;

  @ApiPropertyOptional({
    enum: POPULAR_RANKING_WEIGHT_SCALES,
    description:
      'Scale for content quality impact (low = reduce, med = default, high = boost)',
  })
  @IsOptional()
  @IsIn(POPULAR_RANKING_WEIGHT_SCALES)
  contentQuality?: PopularRankingWeightScale;

  @ApiPropertyOptional({
    enum: POPULAR_RANKING_WEIGHT_SCALES,
    description:
      'Scale for reads impact (low = reduce, med = default, high = boost)',
  })
  @IsOptional()
  @IsIn(POPULAR_RANKING_WEIGHT_SCALES)
  reads?: PopularRankingWeightScale;

  @ApiPropertyOptional({
    enum: POPULAR_RANKING_WEIGHT_SCALES,
    description:
      'Scale for active-engagement velocity using comments, tips, and unique tippers per hour (low = reduce, med = default, high = boost)',
  })
  @IsOptional()
  @IsIn(POPULAR_RANKING_WEIGHT_SCALES)
  interactionsPerHour?: PopularRankingWeightScale;
}
