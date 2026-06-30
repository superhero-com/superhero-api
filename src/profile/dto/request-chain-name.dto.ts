import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';
import { IsSponsoredChainNameLabel } from '../validation/sponsored-chain-name-label.validation';

export class RequestChainNameDto {
  @ApiProperty({
    description: 'Account address (ak_...)',
    example: 'ak_2519mBsgjJEVEFoRgno1ryDsn3BEaCZGRbXPEjThWYLX9MTpmk',
  })
  @IsString()
  @IsAeAccountAddress()
  address: string;

  @ApiProperty({
    description:
      'Desired chain name without the .chain suffix (AENS rules, at least 13 characters).',
    example: 'myuniquename123',
  })
  @IsString()
  @IsSponsoredChainNameLabel()
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
