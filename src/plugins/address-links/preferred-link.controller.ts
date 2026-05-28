import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { PreferredLinkVerifierService } from './verification/preferred-link-verifier.service';
import { ClaimPreferredLinkDto } from './dto/preferred/claim-preferred-link.dto';
import { SubmitPreferredLinkDto } from './dto/preferred/submit-preferred-link.dto';
import { UnclaimPreferredLinkDto } from './dto/preferred/unclaim-preferred-link.dto';
import { SubmitPreferredUnlinkDto } from './dto/preferred/submit-preferred-unlink.dto';
import { PREFERRED_AENS_NAME_PROVIDER } from './address-links.constants';

@Controller('address-links/prefered-aens-name')
export class PreferredLinkController {
  private readonly provider = PREFERRED_AENS_NAME_PROVIDER;

  constructor(
    private readonly service: AddressLinksService,
    private readonly verifier: PreferredLinkVerifierService,
  ) {}

  @Post('claim')
  async claim(@Body() dto: ClaimPreferredLinkDto) {
    const verified = await this.verifier.verifyClaim(dto);
    const result = await this.service.claimLinkPrincipal(
      dto.address,
      this.provider,
      verified.value,
      verified.value,
    );
    return {
      ...result,
      verification_token: verified.verificationToken,
    };
  }

  @Post('submit')
  async submit(@Body() dto: SubmitPreferredLinkDto) {
    await this.verifier.verifySubmit(dto);
    const value = this.verifier.normalizeChainName(dto.value);
    return this.service.submitLinkPrincipal(
      dto.address,
      this.provider,
      value,
      value,
      dto.nonce,
      dto.signature,
    );
  }

  @Post('unclaim')
  async unclaim(@Body() dto: UnclaimPreferredLinkDto) {
    return this.service.claimUnlinkPrincipal(dto.address, this.provider);
  }

  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitPreferredUnlinkDto) {
    const principal = this.verifier.verifyUnlinkPrincipal(dto);
    return this.service.submitUnlinkPrincipal(
      dto.address,
      this.provider,
      principal,
      dto.nonce,
      dto.signature,
    );
  }
}
