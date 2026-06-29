import { ApiProperty } from '@nestjs/swagger';

/**
 * Relay handshake info the app needs for its NIP-42 AUTH flow (Task 13 Req 3,
 * plan §16). NEVER carries the bot nsec — only the public relay URL and the bot's
 * **hex** pubkey (derived from `TG_BOT_NSEC`).
 */
export class RoomConfigViewDto {
  @ApiProperty({
    example: 'wss://relay.superhero.com',
    description: 'groups_relay websocket URL (= TG_RELAY_URL).',
  })
  relay_url: string;

  @ApiProperty({
    example: 'a1b2c3...',
    description:
      'Relay-admin (bot) public key in hex, derived from TG_BOT_NSEC. The nsec is never exposed.',
  })
  admin_pubkey: string;
}
