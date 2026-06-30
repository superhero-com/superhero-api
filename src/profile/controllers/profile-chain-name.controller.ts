import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CreateChainNameChallengeDto } from '../dto/create-chain-name-challenge.dto';
import { RequestChainNameDto } from '../dto/request-chain-name.dto';
import { ProfileChainNameService } from '../services/profile-chain-name.service';
import { AeAccountAddressPipe } from '@/common/validation/request-validation';
import { SponsoredChainNameLabelPipe } from '../validation/sponsored-chain-name-label.validation';

@Controller('profile')
@ApiTags('ProfileChainName')
export class ProfileChainNameController {
  constructor(
    private readonly profileChainNameService: ProfileChainNameService,
  ) {}

  @Post('chain-name/challenge')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    operationId: 'createChainNameChallenge',
    summary:
      'Create a wallet-signing challenge for sponsored chain name claims',
  })
  async createChallenge(@Body() body: CreateChainNameChallengeDto) {
    return this.profileChainNameService.createChallenge(body.address);
  }

  @Post('chain-name/claim')
  @UseGuards(RateLimitGuard)
  @ApiOperation({
    operationId: 'requestChainName',
    summary:
      'Verify wallet ownership and request a sponsored AENS chain name registration.',
  })
  async requestChainName(@Body() body: RequestChainNameDto) {
    return this.profileChainNameService.requestChainName({
      address: body.address,
      name: body.name,
      challengeNonce: body.challenge_nonce,
      challengeExpiresAt: Number(body.challenge_expires_at),
      signatureHex: body.signature_hex,
    });
  }

  @Get('chain-name/sponsorship/:name')
  @ApiOperation({
    operationId: 'checkChainNameSponsorship',
    summary:
      'Check whether the sponsor account has enough balance to fund a chain name claim',
  })
  @ApiParam({
    name: 'name',
    description:
      'Desired chain name without the .chain suffix (AENS rules, at least 13 characters)',
    example: 'myuniquename123',
  })
  async checkChainNameSponsorship(
    @Param('name', SponsoredChainNameLabelPipe) name: string,
  ) {
    return this.profileChainNameService.checkNameSponsorship(name);
  }

  @Get(':address/chain-name-claim')
  @ApiOperation({
    operationId: 'getChainNameClaimStatus',
    summary: 'Get the status of a sponsored chain name claim for an address',
  })
  async getChainNameClaimStatus(
    @Param('address', AeAccountAddressPipe) address: string,
  ) {
    return this.profileChainNameService.getClaimStatus(address);
  }
}
