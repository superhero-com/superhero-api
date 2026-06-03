import { ApiProperty } from '@nestjs/swagger';

/** Public, user-facing shape returned by the catalog endpoint. */
export class PreferenceView {
  @ApiProperty({ example: 'announcement' })
  id: string;

  @ApiProperty({ example: 'Announcements' })
  title: string;

  @ApiProperty({ example: 'Updates and news from the Superhero team.' })
  short_description: string;

  @ApiProperty()
  enabled: boolean;
}
