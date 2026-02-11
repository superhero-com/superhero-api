import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { ProfileService } from '../services/profile.service';
import { IssueProfileChallengeDto } from '../dto/issue-profile-challenge.dto';
import { ConsumeProfileChallengeDto } from '../dto/consume-profile-challenge.dto';
import { AddressParamDto } from '../dto/address-param.dto';
import { VerifyXDto } from '../dto/verify-x.dto';

@ApiTags('Profile')
@UseGuards(RateLimitGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @ApiOperation({ operationId: 'getProfile' })
  @Get(':address')
  async getProfile(@Param('address') address: string) {
    if (!/^ak_[A-Za-z0-9]{30,80}$/.test(address)) {
      throw new BadRequestException('address must be a valid ak_ address');
    }
    return await this.profileService.getProfile(address);
  }

  @ApiOperation({ operationId: 'getOwnedChainNames' })
  @Get(':address/owned-names')
  async getOwnedChainNames(@Param('address') address: string) {
    if (!/^ak_[A-Za-z0-9]{30,80}$/.test(address)) {
      throw new BadRequestException('address must be a valid ak_ address');
    }
    const names = await this.profileService.getOwnedChainNames(address);
    return {
      address,
      owned_chain_names: names,
    };
  }

  @ApiOperation({ operationId: 'issueProfileUpdateChallenge' })
  @Post(':address/challenge')
  async issueChallenge(
    @Param() params: AddressParamDto,
    @Body() body: IssueProfileChallengeDto,
    @Req() req: Request,
  ) {
    return await this.profileService.issueUpdateChallenge(
      params.address,
      body,
      this.getClientIp(req),
      req.headers['user-agent'],
    );
  }

  @ApiOperation({ operationId: 'updateProfile' })
  @Patch(':address')
  async updateProfile(
    @Param() params: AddressParamDto,
    @Body() body: ConsumeProfileChallengeDto,
    @Req() req: Request,
  ) {
    return await this.profileService.updateProfileWithChallenge(
      params.address,
      body,
      this.getClientIp(req),
    );
  }

  @ApiOperation({ operationId: 'verifyXUsername' })
  @Post(':address/verify-x')
  async verifyXUsername(
    @Param() params: AddressParamDto,
    @Body() body: VerifyXDto,
  ) {
    return await this.profileService.verifyXUsername(
      params.address,
      body.access_code,
    );
  }

  private getClientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    return (
      (typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : forwarded?.[0]) ||
      request.ip ||
      request.socket.remoteAddress ||
      'unknown'
    );
  }
}
