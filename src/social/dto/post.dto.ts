import { ApiProperty } from '@nestjs/swagger';
import { PostTrendMentionDto } from './post-trend-mention.dto';
import { PostSenderDto } from './post-sender.dto';

export class PostDto {
  @ApiProperty({
    description: 'Unique identifier for the post',
    example: '12345_v1',
  })
  id: string;

  @ApiProperty({
    description: 'Transaction hash associated with the post',
    example: 'th_1234567890abcdef...',
  })
  tx_hash: string;

  @ApiProperty({
    description: 'Transaction arguments as JSON array',
    type: 'array',
    items: { type: 'object' },
    example: [{ type: 'string', value: 'Hello world!' }],
  })
  tx_args: any[];

  @ApiProperty({
    description: 'Address of the post sender/creator',
    example: 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
  })
  sender_address: string;

  @ApiProperty({
    description: 'Minimal sender profile info',
    type: () => PostSenderDto,
  })
  sender: PostSenderDto;

  @ApiProperty({
    description: 'Address of the smart contract',
    example: 'ct_2AfnEfCSPx4A6UYXj2XHDqHXcC7EF2bgbp8UN1KPAJDysPJT32',
  })
  contract_address: string;

  @ApiProperty({
    description: 'Type of the post/transaction',
    example: 'post',
  })
  type: string;

  @ApiProperty({
    description: 'Main content of the post',
    example: 'Hello world! This is my first post on the blockchain.',
  })
  content: string;

  @ApiProperty({
    description: 'Trend mentions extracted from #trendName in content',
    type: () => [PostTrendMentionDto],
    required: false,
  })
  trend_mentions?: PostTrendMentionDto[];

  @ApiProperty({
    description: 'Array of media URLs associated with the post',
    type: [String],
    example: ['https://example.com/image.jpg', 'https://example.com/video.mp4'],
  })
  media: string[];

  @ApiProperty({
    description: 'Total number of comments on this post',
    example: 5,
  })
  total_comments: number;

  @ApiProperty({
    description: 'Timestamp when the post was created',
    type: 'string',
    format: 'date-time',
    example: '2023-12-01T10:30:00.000Z',
  })
  created_at: Date;
}
