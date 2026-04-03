import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Matches,
  MaxLength,
} from 'class-validator';

export class SubmitUnlinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @Matches(/^[a-z]+$/)
  @MaxLength(10)
  provider: string;

  @IsNumber()
  nonce: number;

  /** Hex-encoded AE wallet signature. */
  @IsString()
  @IsNotEmpty()
  signature: string;
}
