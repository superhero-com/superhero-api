import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { XLinkVerifierService } from './verification/x-link-verifier.service';
import { ClaimXLinkDto } from './dto/x/claim-x-link.dto';
import { SubmitXLinkDto } from './dto/x/submit-x-link.dto';
import { UnclaimXLinkDto } from './dto/x/unclaim-x-link.dto';
import { SubmitXUnlinkDto } from './dto/x/submit-x-unlink.dto';

@Controller('address-links/x')
export class XLinkController {
  private readonly provider = 'x';

  constructor(
    private readonly service: AddressLinksService,
    private readonly verifier: XLinkVerifierService,
  ) {}

  @Post('claim')
  async claim(@Body() dto: ClaimXLinkDto) {
    const verified = await this.verifier.verifyClaim(dto.address, dto);
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
  async submit(@Body() dto: SubmitXLinkDto) {
    await this.verifier.verifySubmit(dto);
    return this.service.submitLink(
      dto.address,
      this.provider,
      dto.value,
      dto.nonce,
      dto.signature,
    );
  }

  @Post('unclaim')
  async unclaim(@Body() dto: UnclaimXLinkDto) {
    return this.service.claimUnlink(dto.address, this.provider);
  }

  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitXUnlinkDto) {
    return this.service.submitUnlink(
      dto.address,
      this.provider,
      dto.nonce,
      dto.signature,
    );
  }
}
