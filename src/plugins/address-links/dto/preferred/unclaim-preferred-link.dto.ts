import { IsString, IsNotEmpty } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class UnclaimPreferredLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;
}
