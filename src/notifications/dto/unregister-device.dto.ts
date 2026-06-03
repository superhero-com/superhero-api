import { IsAeAccountAddress } from '@/common/validation/request-validation';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { EXPO_PUSH_TOKEN_REGEX } from '../expo/expo-push.client';

export class UnregisterDeviceDto {
  @ApiProperty({ example: 'ak_2sZ...' })
  @IsAeAccountAddress()
  address: string;

  @ApiProperty({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' })
  @IsString()
  @Matches(EXPO_PUSH_TOKEN_REGEX, {
    message: 'expoPushToken must be a valid Expo push token',
  })
  expoPushToken: string;

  @ApiProperty({ description: 'Nonce returned by /devices/challenge' })
  @IsString()
  nonce: string;

  @ApiProperty({ description: 'Signature of the unlink challenge message' })
  @IsString()
  signature: string;
}
