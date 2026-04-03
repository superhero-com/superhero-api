import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { ClaimLinkDto } from './dto/claim-link.dto';
import { SubmitLinkDto } from './dto/submit-link.dto';
import { ClaimUnlinkDto } from './dto/claim-unlink.dto';
import { SubmitUnlinkDto } from './dto/submit-unlink.dto';

@Controller('address-links')
export class AddressLinksController {
  constructor(private readonly service: AddressLinksService) {}

  @Post('claim')
  async claimLink(@Body() dto: ClaimLinkDto) {
    return this.service.claimLink(dto);
  }

  @Post('submit')
  async submitLink(@Body() dto: SubmitLinkDto) {
    return this.service.submitLink(dto);
  }

  @Post('unclaim')
  async claimUnlink(@Body() dto: ClaimUnlinkDto) {
    return this.service.claimUnlink(dto.address, dto.provider);
  }

  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitUnlinkDto) {
    return this.service.submitUnlink(
      dto.address,
      dto.provider,
      dto.nonce,
      dto.signature,
    );
  }
}
