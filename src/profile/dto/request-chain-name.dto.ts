import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength, Validate } from 'class-validator';
import { AeAccountAddressConstraint } from './ae-account-address.validator';

export class RequestChainNameDto {
  @ApiProperty({
    description: 'Account address (ak_...)',
    example: 'ak_2519mBsgjJEVEFoRgno1ryDsn3BEaCZGRbXPEjThWYLX9MTpmk',
  })
  @IsString()
  @Validate(AeAccountAddressConstraint)
  address: string;

  @ApiProperty({
    description:
      'Desired chain name without the .chain suffix. Must be longer than 12 characters.',
    example: 'myuniquename123',
  })
  @IsString()
  @MinLength(13)
  @Matches(/^[a-z0-9]+$/, {
    message: 'name must contain only lowercase letters and digits',
  })
  name: string;

  @ApiProperty({
    description: 'Challenge nonce returned by the challenge endpoint',
    example: 'a7f3d58f7fba7acfb35cb2097d364f0c1d6473a9126a4d6d',
  })
  @IsString()
  challenge_nonce: string;

  @ApiProperty({
    description:
      'Challenge expiry timestamp returned by the challenge endpoint',
    example: '1711974659000',
  })
  @IsString()
  challenge_expires_at: string;

  @ApiProperty({
    description:
      'Wallet signature for the returned challenge message, as hex or sg_ string',
    example: 'f'.repeat(128),
  })
  @IsString()
  signature_hex: string;
}
