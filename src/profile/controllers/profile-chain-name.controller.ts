import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateChainNameChallengeDto } from '../dto/create-chain-name-challenge.dto';
import { RequestChainNameDto } from '../dto/request-chain-name.dto';
import { ProfileChainNameService } from '../services/profile-chain-name.service';

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

  @Get(':address/chain-name-claim')
  @ApiOperation({
    operationId: 'getChainNameClaimStatus',
    summary: 'Get the status of a sponsored chain name claim for an address',
  })
  async getChainNameClaimStatus(@Param('address') address: string) {
    return this.profileChainNameService.getClaimStatus(address);
  }
}
