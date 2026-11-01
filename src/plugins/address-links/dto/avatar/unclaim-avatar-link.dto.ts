import { IsString, IsNotEmpty } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class UnclaimAvatarLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;
}
