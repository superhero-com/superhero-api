import { ApiProperty } from '@nestjs/swagger';
import { TokenDto } from '@/tokens/dto/token.dto';

export class TopicDto {
  @ApiProperty({
    description: 'Unique identifier for the topic',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id: string;

  @ApiProperty({
    description: 'Name of the topic/hashtag',
    example: 'blockchain',
  })
  name: string;

  @ApiProperty({
    description: 'Description of the topic',
    example: 'Discussions about blockchain technology',
    nullable: true,
  })
  description: string;

  @ApiProperty({
    description: 'Number of posts with this topic',
    example: 42,
  })
  post_count: number;

  @ApiProperty({
    description: 'Associated token if topic name matches a token symbol',
    type: () => TokenDto,
    nullable: true,
  })
  token?: TokenDto;

  @ApiProperty({
    description: 'Timestamp when the topic was created',
    type: 'string',
    format: 'date-time',
    example: '2023-12-01T10:30:00.000Z',
  })
  created_at: Date;

  @ApiProperty({
    description: 'Timestamp when the topic was last updated',
    type: 'string',
    format: 'date-time',
    example: '2023-12-01T10:30:00.000Z',
  })
  updated_at: Date;

  @ApiProperty({
    description: 'Version number',
    example: 0,
  })
  version: number;
}
