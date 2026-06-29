import { ApiProperty } from '@nestjs/swagger';

/**
 * A resolved nostr-pubkey → aeternity-account reference. Returned by
 * `GET /api/accounts/by-nostr` so clients can show the AE identity (chain name /
 * `ak_` address) for a nostr pubkey instead of the raw hex key — e.g. in a
 * NIP-29 group's member list and membership system lines.
 */
export class NostrAccountRefDto {
  @ApiProperty({
    description:
      'The matched nostr pubkey, normalized to lowercase 64-char hex.',
    example: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
  })
  nostr_pubkey: string;

  @ApiProperty({
    description: 'The aeternity account that linked this nostr pubkey.',
    example: 'ak_2EdPu7gFkFsUojaCBz4XV3vBrSrEK19gtb3iX7uHzMNkMVaqYJ',
  })
  address: string;

  @ApiProperty({
    description: "The account's `.chain` name, if any.",
    nullable: true,
    example: 'alice.chain',
  })
  chain_name: string | null;
}
