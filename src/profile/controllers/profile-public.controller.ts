import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AeAccountAddressPipe,
  isAeAccountAddress,
} from '../../common/validation/request-validation';
import { ProfileReadService } from '../services/profile-read.service';

/** The public read surface is independent of invitation and reward writes. */
@Controller('profile')
@ApiTags('Profile')
export class ProfilePublicController {
  constructor(private readonly profiles: ProfileReadService) {}
  @Get()
  @ApiOperation({ operationId: 'getPublicProfiles' })
  batch(@Query('addresses') addresses: string) {
    if (typeof addresses !== 'string' || addresses.length > 5000)
      throw new BadRequestException('Provide up to 50 wallet addresses');
    const values = addresses.split(',').map((value) => value.trim());
    if (
      !values.length ||
      values.length > 50 ||
      !values.every(isAeAccountAddress)
    )
      throw new BadRequestException('Provide up to 50 wallet addresses');
    return this.profiles.getProfilesByAddresses(values);
  }
  @Get(':address')
  @ApiOperation({ operationId: 'getPublicProfile' })
  profile(@Param('address', AeAccountAddressPipe) address: string) {
    return this.profiles.getProfile(address);
  }
}
