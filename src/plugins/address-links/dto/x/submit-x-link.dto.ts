import { IsString, IsNotEmpty, IsNumber, MaxLength } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class SubmitXLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;

  @IsNumber()
  nonce: number;

  /** Hex-encoded AE wallet signature. */
  @IsString()
  @IsNotEmpty()
  signature: string;

  /** Server-signed verification token issued at claim time. */
  @IsString()
  @IsNotEmpty()
  verification_token: string;
}
