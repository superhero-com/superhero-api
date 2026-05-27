import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { SiteLinkVerifierService } from './verification/site-link-verifier.service';
import { ClaimSiteLinkDto } from './dto/site/claim-site-link.dto';
import { SubmitSiteLinkDto } from './dto/site/submit-site-link.dto';
import { UnclaimSiteLinkDto } from './dto/site/unclaim-site-link.dto';
import { SubmitSiteUnlinkDto } from './dto/site/submit-site-unlink.dto';

@Controller('address-links/site')
export class SiteLinkController {
  private readonly provider = 'site';

  constructor(
    private readonly service: AddressLinksService,
    private readonly verifier: SiteLinkVerifierService,
  ) {}

  @Post('claim')
  async claim(@Body() dto: ClaimSiteLinkDto) {
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
  async submit(@Body() dto: SubmitSiteLinkDto) {
    await this.verifier.verifySubmit(dto);
    const value = this.verifier.normalizeSite(dto.value);
    return this.service.submitLink(
      dto.address,
      this.provider,
      value,
      dto.nonce,
      dto.signature,
    );
  }

  @Post('unclaim')
  async unclaim(@Body() dto: UnclaimSiteLinkDto) {
    return this.service.claimUnlink(dto.address, this.provider);
  }

  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitSiteUnlinkDto) {
    return this.service.submitUnlink(
      dto.address,
      this.provider,
      dto.nonce,
      dto.signature,
    );
  }
}
