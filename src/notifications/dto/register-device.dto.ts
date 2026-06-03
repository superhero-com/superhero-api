import { IsAeAccountAddress } from '@/common/validation/request-validation';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { DevicePlatform } from '../entities/device-token.entity';
import { EXPO_PUSH_TOKEN_REGEX } from '../expo/expo-push.client';

export class RegisterDeviceDto {
  @ApiProperty({ example: 'ak_2sZ...' })
  @IsAeAccountAddress()
  address: string;

  @ApiProperty({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' })
  @IsString()
  @Matches(EXPO_PUSH_TOKEN_REGEX, {
    message: 'expoPushToken must be a valid Expo push token',
  })
  expoPushToken: string;

  @ApiProperty({ enum: ['ios', 'android', 'web'] })
  @IsIn(['ios', 'android', 'web'])
  platform: DevicePlatform;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  appVersion?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiProperty({ description: 'Nonce returned by /devices/challenge' })
  @IsString()
  nonce: string;

  @ApiProperty({
    description: 'Signature of the challenge message (sg_... or hex)',
  })
  @IsString()
  signature: string;
}
