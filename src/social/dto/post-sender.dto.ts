import { ApiProperty } from '@nestjs/swagger';

export class PostSenderDto {
  @ApiProperty({
    description: 'Sender account address',
    example: 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
  })
  address: string;

  @ApiProperty({
    description: 'Public profile name resolved from profile display source',
    example: 'hero_name',
  })
  public_name: string;

  @ApiProperty({
    description: 'Profile bio for the sender',
    example: 'Building on AE',
  })
  bio: string;

  @ApiProperty({
    description: 'Profile avatar URL for the sender',
    example: 'https://example.com/avatar.png',
  })
  avatarurl: string;

  @ApiProperty({
    description: 'Selected source used for public profile name',
    example: 'custom',
  })
  display_source: string;
}
