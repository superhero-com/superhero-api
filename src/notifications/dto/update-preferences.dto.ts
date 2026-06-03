import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PreferenceUpdateItem {
  @ApiProperty({ description: 'Notification type id (e.g. "announcement")' })
  @IsString()
  type: string;

  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}

export class UpdatePreferencesDto {
  @ApiProperty({
    description: 'Nonce returned by POST /notifications/preferences/challenge',
  })
  @IsString()
  nonce: string;

  @ApiProperty({
    description: 'Signature of the challenge message (sg_... or hex)',
  })
  @IsString()
  signature: string;

  @ApiProperty({
    type: [PreferenceUpdateItem],
    description:
      'Partial update — only types listed here are upserted; others keep their state.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PreferenceUpdateItem)
  preferences: PreferenceUpdateItem[];
}
