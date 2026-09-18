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
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    operationId: 'getXPostingRewardStatus',
    summary: 'Get X posting reward status for an address',
  })
  async getXPostingRewardStatus(
    @Param('address', AeAccountAddressPipe) address: string,
  ) {
    // Opening the rewards page starts a check when one is due. Nothing runs on
    // a schedule, so without this a user who linked X and posted is never
    // looked at again unless they come back and press the button — which is
    // how wallets ended up verified and unpaid for months.
    //
    // Deliberately not awaited: the status returns immediately from what is
    // already known, and the refreshed numbers appear on the next load. The
    // call swallows its own failures, so this cannot turn a read into an error.
    //
    // This route is unauthenticated, so be precise about what a stranger can
    // set in motion by naming an address. The SCAN is capped at one per address
    // per window. The SETTLE pass deliberately sits AHEAD of that cap (a failed
    // payout must not wait out the window), so the cap does not bound it —
    // `hasSettleableWork` does, by reducing every wallet that is not actually
    // owed money to a single row read.
    // The `.catch` is belt-and-braces: the service already swallows its own
    // failures, but nothing here would survive that guarantee being removed
    // later, and an unhandled rejection on a read path is not worth the risk.
    void this.profileXPostingRewardService
      .refreshInBackgroundIfDue(address)
      ?.catch(() => undefined);
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

  @Post(':address/x-reward/referral-link')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    operationId: 'createXRewardReferralLink',
    summary:
      'Verify wallet ownership and mint (or return) the unique X reward referral link',
  })
  async createXRewardReferralLink(
    @Param('address', AeAccountAddressPipe) address: string,
    @Body() body: SubmitXPostingRecheckDto,
  ) {
    await this.profileXInviteService.verifyPostingRewardRecheckChallenge({
      address,
      nonce: body.challenge_nonce,
      expiresAt: Number(body.challenge_expires_at),
      signatureHex: body.signature_hex,
    });
    return this.profileXPostingRewardService.getOrCreateReferralLink(address);
  }
}
