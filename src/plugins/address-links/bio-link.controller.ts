import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { BioLinkVerifierService } from './verification/bio-link-verifier.service';
import { ClaimBioLinkDto } from './dto/bio/claim-bio-link.dto';
import { SubmitBioLinkDto } from './dto/bio/submit-bio-link.dto';
import { UnclaimBioLinkDto } from './dto/bio/unclaim-bio-link.dto';
import { SubmitBioUnlinkDto } from './dto/bio/submit-bio-unlink.dto';

@Controller('address-links/bio')
export class BioLinkController {
  private readonly provider = 'bio';

  constructor(
    private readonly service: AddressLinksService,
    private readonly verifier: BioLinkVerifierService,
  ) {}

  @Post('claim')
  async claim(@Body() dto: ClaimBioLinkDto) {
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
  async submit(@Body() dto: SubmitBioLinkDto) {
    await this.verifier.verifySubmit(dto);
    return this.service.submitLink(
      dto.address,
      this.provider,
      dto.value.trim(),
      dto.nonce,
      dto.signature,
    );
  }

  @Post('unclaim')
  async unclaim(@Body() dto: UnclaimBioLinkDto) {
    return this.service.claimUnlink(dto.address, this.provider);
  }

  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitBioUnlinkDto) {
    return this.service.submitUnlink(
      dto.address,
      this.provider,
      dto.nonce,
      dto.signature,
    );
  }
}
