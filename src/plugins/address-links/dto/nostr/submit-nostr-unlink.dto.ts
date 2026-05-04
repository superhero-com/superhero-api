import { IsString, IsNotEmpty, IsNumber } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class SubmitNostrUnlinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;

  @IsNumber()
  nonce: number;

  /** Hex-encoded AE wallet signature. */
  @IsString()
  @IsNotEmpty()
  signature: string;
}
