import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateXPostingRecheckChallengeDto } from '../dto/create-x-posting-recheck-challenge.dto';
import { SubmitXPostingRecheckDto } from '../dto/submit-x-posting-recheck.dto';
import { ProfileXInviteService } from '../services/profile-x-invite.service';
import { ProfileXPostingRewardService } from '../services/profile-x-posting-reward.service';
import { AeAccountAddressPipe } from '@/common/validation/request-validation';

@Controller('profile')
@ApiTags('ProfileRewards')
export class ProfileRewardsController {
  constructor(
    private readonly profileXInviteService: ProfileXInviteService,
    private readonly profileXPostingRewardService: ProfileXPostingRewardService,
  ) {}

  @Get(':address/x-posting-reward')
  @ApiOperation({
    operationId: 'getXPostingRewardStatus',
    summary: 'Get X posting reward status for an address',
  })
  async getXPostingRewardStatus(
    @Param('address', AeAccountAddressPipe) address: string,
  ) {
    return this.profileXPostingRewardService.getRewardStatus(address);
  }

  @Post('x-posting-reward/recheck-challenge')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    operationId: 'createXPostingRewardRecheckChallenge',
    summary: 'Create a wallet-signing challenge for X posting reward recheck',
  })
  async createXPostingRewardRecheckChallenge(
    @Body() body: CreateXPostingRecheckChallengeDto,
  ) {
    return this.profileXInviteService.createPostingRewardRecheckChallenge(
      body.address,
    );
  }

  @Post(':address/x-posting-reward/recheck')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    operationId: 'recheckXPostingReward',
    summary:
      'Verify wallet ownership and run an on-demand X posting reward recheck',
  })
  async recheckXPostingReward(
    @Param('address', AeAccountAddressPipe) address: string,
    @Body() body: SubmitXPostingRecheckDto,
  ) {
    await this.profileXInviteService.verifyPostingRewardRecheckChallenge({
      address,
      nonce: body.challenge_nonce,
      expiresAt: Number(body.challenge_expires_at),
      signatureHex: body.signature_hex,
    });
    return this.profileXPostingRewardService.requestManualRecheck(address);
  }
}
