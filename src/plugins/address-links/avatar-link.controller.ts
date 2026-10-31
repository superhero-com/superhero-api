import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { AvatarLinkVerifierService } from './verification/avatar-link-verifier.service';
import { ClaimAvatarLinkDto } from './dto/avatar/claim-avatar-link.dto';
import { SubmitAvatarLinkDto } from './dto/avatar/submit-avatar-link.dto';
import { UnclaimAvatarLinkDto } from './dto/avatar/unclaim-avatar-link.dto';
import { SubmitAvatarUnlinkDto } from './dto/avatar/submit-avatar-unlink.dto';

@Controller('address-links/avatar')
export class AvatarLinkController {
  private readonly provider = 'avatar';

  constructor(
    private readonly service: AddressLinksService,
    private readonly verifier: AvatarLinkVerifierService,
  ) {}

  @Post('claim')
  async claim(@Body() dto: ClaimAvatarLinkDto) {
    const verified = await this.verifier.verifyClaim(dto);
    const result = await this.service.claimLink(
      dto.address,
      this.provider,
      verified.value,
    );
    return {
      ...result,
      verification_token: verified.verificationToken,
    };
  }

  @Post('submit')
  async submit(@Body() dto: SubmitAvatarLinkDto) {
    await this.verifier.verifySubmit(dto);
    const value = this.verifier.normalizeAvatar(dto.value);
    return this.service.submitLink(
      dto.address,
      this.provider,
      value,
      dto.nonce,
      dto.signature,
    );
  }

  @Post('unclaim')
  async unclaim(@Body() dto: UnclaimAvatarLinkDto) {
    return this.service.claimUnlink(dto.address, this.provider);
  }

  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitAvatarUnlinkDto) {
    return this.service.submitUnlink(
      dto.address,
      this.provider,
      dto.nonce,
      dto.signature,
    );
  }
}
