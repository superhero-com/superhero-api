import { IsString, IsNotEmpty } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

export class UnclaimSiteLinkDto {
  @IsString()
  @IsNotEmpty()
  @IsAeAccountAddress()
  address: string;
}
