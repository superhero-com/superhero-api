import { IsString, IsNotEmpty, IsNumber } from 'class-validator';

export class SubmitNostrUnlinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsNumber()
  nonce: number;

  /** Hex-encoded AE wallet signature. */
  @IsString()
  @IsNotEmpty()
  signature: string;
}
