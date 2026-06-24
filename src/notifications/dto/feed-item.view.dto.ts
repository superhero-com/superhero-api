import { ApiProperty } from '@nestjs/swagger';
import { NotificationRecord } from '../entities/notification.entity';

/**
 * Public, user-facing shape of one feed notification. This is the single payload
 * shared by the REST feed list, the unread-count delta, and the live socket
 * `notification` event — so a live item and a fetched item are byte-identical
 * and the frontend can dedupe them by `id`.
 */
export class FeedItemView {
  @ApiProperty({ example: 42 })
  id: number;

  @ApiProperty({ example: 'incoming-transfer' })
  type: string;

  @ApiProperty({ example: 'Payment received' })
  title: string;

  @ApiProperty({ example: 'You received 5 AE from superhero.chain' })
  body: string;

  @ApiProperty({
    required: false,
    description: 'Type-specific payload (txHash, sender, deep-link hints, …).',
  })
  data: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  read_at: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: string;
}

/** Map a persisted row to its wire shape. */
export function toFeedItemView(record: NotificationRecord): FeedItemView {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    data: record.data ?? null,
    read_at: record.read_at ? record.read_at.toISOString() : null,
    created_at: record.created_at.toISOString(),
  };
}
