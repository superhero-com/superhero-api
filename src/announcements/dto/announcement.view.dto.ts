import { ApiProperty } from '@nestjs/swagger';

/** Public, user-facing shape. Operational/internal columns are never exposed. */
export class AnnouncementView {
  @ApiProperty()
  id: number;

  @ApiProperty()
  title: string;

  @ApiProperty()
  description: string;

  @ApiProperty({
    description: 'When the announcement went out (from processed_at).',
  })
  published_at: Date;
}
