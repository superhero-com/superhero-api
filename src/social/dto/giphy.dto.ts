import { ApiProperty } from '@nestjs/swagger';

export class GiphyGifDto {
  @ApiProperty({ example: 'xT4uQulxzV39haRFjG' })
  id: string;

  @ApiProperty({
    example: 'https://media.giphy.com/media/xT4u/200w_s.gif',
    nullable: true,
  })
  still: string | null;

  @ApiProperty({
    example: 'https://media.giphy.com/media/xT4u/200w.gif',
    nullable: true,
  })
  animated: string | null;

  @ApiProperty({
    example: 'https://media.giphy.com/media/xT4u/200w.mp4',
    nullable: true,
  })
  mp4: string | null;

  @ApiProperty({
    example: 'https://media.giphy.com/media/xT4u/giphy.gif',
    nullable: true,
  })
  original: string | null;

  @ApiProperty({ example: 480, description: 'Original width in pixels' })
  width: number;

  @ApiProperty({ example: 270, description: 'Original height in pixels' })
  height: number;
}

export class GiphySearchResponseDto {
  @ApiProperty({ type: [GiphyGifDto] })
  results: GiphyGifDto[];

  @ApiProperty({ example: 1000 })
  totalCount: number;

  @ApiProperty({ example: 12, description: 'Offset to pass for the next page' })
  nextOffset: number;

  @ApiProperty({ example: true })
  hasMore: boolean;
}
