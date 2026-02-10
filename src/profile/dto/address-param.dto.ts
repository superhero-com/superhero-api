import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

const ADDRESS_PATTERN = /^ak_[A-Za-z0-9]{30,80}$/;

export class AddressParamDto {
  @ApiProperty({
    example: 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi',
  })
  @Matches(ADDRESS_PATTERN, { message: 'address must be a valid ak_ address' })
  address: string;
}
