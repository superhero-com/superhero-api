import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';
import { PRICE_ALERT_TARGET_RE } from '../price-alerts/price-alert.service';

export class CreatePriceAlertDto {
  @ApiProperty({
    description: 'Nonce returned by POST /notifications/preferences/challenge',
  })
  @IsString()
  nonce: string;

  @ApiProperty({ description: 'Signature of the price-alert message' })
  @IsString()
  signature: string;

  @ApiProperty({ description: 'Token sale contract (ct_...)' })
  @IsString()
  @Matches(/^ct_[1-9A-HJ-NP-Za-km-z]{38,60}$/)
  sale_address: string;

  @ApiProperty({ enum: ['above', 'below'] })
  @IsIn(['above', 'below'])
  direction: 'above' | 'below';

  @ApiProperty({ description: 'Target price in AE per token', example: '0.01' })
  @IsString()
  @Matches(PRICE_ALERT_TARGET_RE)
  target_ae: string;
}

export class DeletePriceAlertDto {
  @ApiProperty()
  @IsString()
  nonce: string;

  @ApiProperty()
  @IsString()
  signature: string;
}

export class PriceAlertViewDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  sale_address: string;

  @ApiProperty({ nullable: true })
  symbol: string | null;

  @ApiProperty({ enum: ['above', 'below'] })
  direction: 'above' | 'below';

  @ApiProperty()
  target_ae: string;

  @ApiProperty()
  created_at: Date;

  @ApiProperty({ nullable: true })
  triggered_at: Date | null;
}
