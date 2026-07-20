import { ApiProperty } from '@nestjs/swagger';
import { FeedItemView } from './feed-item.view.dto';

/** One page of the feed, newest-first. */
export class FeedListView {
  @ApiProperty({ type: [FeedItemView] })
  items: FeedItemView[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Pass as `cursor` to fetch the next (older) page; null at end.',
  })
  nextCursor: number | null;
}

export class UnreadCountView {
  @ApiProperty({ example: 3 })
  count: number;
}

/** Returned by the session-mint endpoint. */
export class FeedSessionView {
  @ApiProperty({
    description: 'Bearer token for Authorization header + socket auth.',
  })
  token: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: string;
}
