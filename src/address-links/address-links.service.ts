import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { AddressLinksContractService } from './contract.service';
import { ClaimLinkDto } from './dto/claim-link.dto';
import { SubmitLinkDto } from './dto/submit-link.dto';
import { LinkVerifier } from './verification/link-verifier.interface';
import { XLinkVerifierService } from './verification/x-link-verifier.service';
import { NostrLinkVerifierService } from './verification/nostr-link-verifier.service';

@Injectable()
export class AddressLinksService {
  private readonly logger = new Logger(AddressLinksService.name);
  private readonly verifiers: Record<string, LinkVerifier>;

  constructor(
    private readonly contractService: AddressLinksContractService,
    xVerifier: XLinkVerifierService,
    nostrVerifier: NostrLinkVerifierService,
  ) {
    this.verifiers = {
      x: xVerifier,
      nostr: nostrVerifier,
    };
  }

  async claimLink(dto: ClaimLinkDto) {
    const verifier = this.getVerifier(dto.provider);
    const verified = await verifier.verifyClaim(dto.address, dto);

    const value = verified.value;
    this.validateValue(value);

    const nonce = await this.contractService.getNonce(dto.address);
    const message = this.contractService.buildLinkMessage(
      dto.address,
      dto.provider,
      value,
      nonce,
    );

    return {
      message,
      nonce,
      value,
      ...(verified.verificationToken
        ? { verification_token: verified.verificationToken }
        : {}),
    };
  }

  async submitLink(dto: SubmitLinkDto) {
    this.validateValue(dto.value);

    const message = this.contractService.buildLinkMessage(
      dto.address,
      dto.provider,
      dto.value,
      dto.nonce,
    );

    const verifier = this.getVerifier(dto.provider);
    await verifier.verifySubmit(dto, message);

    const tx = await this.contractService.link(
      dto.address,
      dto.provider,
      dto.value,
      dto.nonce,
      dto.signature,
    );

    return { txHash: tx.hash };
  }

  async claimUnlink(address: string, provider: string) {
    this.getVerifier(provider);
    const nonce = await this.contractService.getNonce(address);
    const message = this.contractService.buildUnlinkMessage(
      address,
      provider,
      nonce,
    );

    return { message, nonce };
  }

  async submitUnlink(
    address: string,
    provider: string,
    nonce: number,
    signature: string,
  ) {
    this.getVerifier(provider);
    const tx = await this.contractService.unlink(
      address,
      provider,
      nonce,
      signature,
    );

    return { txHash: tx.hash };
  }

  private getVerifier(provider: string): LinkVerifier {
    const verifier = this.verifiers[provider];
    if (!verifier) {
      throw new BadRequestException(
        `Unsupported provider: ${provider}. Supported: ${Object.keys(this.verifiers).join(', ')}`,
      );
    }
    return verifier;
  }

  private validateValue(value: string) {
    if (value.includes(':')) {
      throw new BadRequestException('Value must not contain ":"');
    }
  }
}
