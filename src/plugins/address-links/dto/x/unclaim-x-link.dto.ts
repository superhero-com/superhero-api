import { IsString, IsNotEmpty } from 'class-validator';

export class UnclaimXLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;
}
