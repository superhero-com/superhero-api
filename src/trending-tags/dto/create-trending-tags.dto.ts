import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsString, ValidateNested } from 'class-validator';

export class TrendingTagItemDto {
  @ApiProperty({ description: 'The tag name', example: 'blockchain' })
  @IsString()
  @IsNotEmpty()
  tag: string;

  @ApiProperty({ description: 'The score for the tag', example: '95.5' })
  @IsString()
  @IsNotEmpty()
  score: string;
}

export class CreateTrendingTagsDto {
  @ApiProperty({
    description: 'The provider source (e.g., x, facebook, github)',
    example: 'x',
  })
  @IsString()
  @IsNotEmpty()
  provider: string;

  @ApiProperty({
    description: 'Array of trending tag items',
    type: [TrendingTagItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrendingTagItemDto)
  items: TrendingTagItemDto[];
}
