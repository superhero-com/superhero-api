import { ApiProperty } from '@nestjs/swagger';

export class CollectionInfoDto {
  @ApiProperty({
    description: 'Full collection id, "<NAME>-ak_<deployer>"',
    example: 'CHINESE-ak_2AoM8kAJn9Q6zVbxjfoBUfMkyfP8SxgoZ2Nw88M4Xd8Xk8ct6r',
  })
  id: string;

  @ApiProperty({
    description: 'Human-readable collection name (badge label)',
    example: 'CHINESE',
  })
  name: string;

  @ApiProperty({ required: false, nullable: true })
  description?: string;

  @ApiProperty({
    description: 'Max token name length allowed in this collection',
    example: '20',
  })
  allowed_name_length: string;
}
