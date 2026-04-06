import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { NostrLinkVerifierService } from './verification/nostr-link-verifier.service';
import { ClaimNostrLinkDto } from './dto/nostr/claim-nostr-link.dto';
import { SubmitNostrLinkDto } from './dto/nostr/submit-nostr-link.dto';
import { UnclaimNostrLinkDto } from './dto/nostr/unclaim-nostr-link.dto';
import { SubmitNostrUnlinkDto } from './dto/nostr/submit-nostr-unlink.dto';

@Controller('address-links/nostr')
export class NostrLinkController {
  private readonly provider = 'nostr';

  constructor(
    private readonly service: AddressLinksService,
    private readonly verifier: NostrLinkVerifierService,
  ) {}

  @Post('claim')
  async claim(@Body() dto: ClaimNostrLinkDto) {
    await this.verifier.verifyClaim(dto);
    return this.service.claimLink(dto.address, this.provider, dto.value);
  }

  @Post('submit')
  async submit(@Body() dto: SubmitNostrLinkDto) {
    const message = this.service.buildLinkMessage(
      dto.address,
      this.provider,
      dto.value,
      dto.nonce,
    );
    await this.verifier.verifySubmit(dto, message);
    return this.service.submitLink(
      dto.address,
      this.provider,
      dto.value,
      dto.nonce,
      dto.signature,
    );
  }

  @Post('unclaim')
  async unclaim(@Body() dto: UnclaimNostrLinkDto) {
    return this.service.claimUnlink(dto.address, this.provider);
  }

  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitNostrUnlinkDto) {
    return this.service.submitUnlink(
      dto.address,
      this.provider,
      dto.nonce,
      dto.signature,
    );
  }
}
