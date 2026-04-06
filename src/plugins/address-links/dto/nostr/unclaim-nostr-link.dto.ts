import { IsString, IsNotEmpty } from 'class-validator';

export class UnclaimNostrLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;
}
