import { ApiProperty } from '@nestjs/swagger';

/**
 * A single typeahead match returned by `GET /api/accounts/search`. Used to
 * power account autocomplete (search by chain name / address).
 */
export class AccountSearchResultDto {
  @ApiProperty({
    description: 'The matched account address.',
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
