import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { AddressLinksContractService } from './contract.service';

@Injectable()
export class AddressLinksService {
  private readonly logger = new Logger(AddressLinksService.name);

  constructor(
    private readonly contractService: AddressLinksContractService,
  ) {}

  buildLinkMessage(
    address: string,
    provider: string,
    value: string,
    nonce: number,
  ): string {
    return this.contractService.buildLinkMessage(address, provider, value, nonce);
  }

  async claimLink(address: string, provider: string, value: string) {
    this.validateValue(value);

    const nonce = await this.contractService.getNonce(address);
    const message = this.contractService.buildLinkMessage(
      address,
      provider,
      value,
      nonce,
    );

    return { message, nonce, value };
  }

  async submitLink(
    address: string,
    provider: string,
    value: string,
    nonce: number,
    signature: string,
  ) {
    this.validateValue(value);

    const tx = await this.contractService.link(
      address,
      provider,
      value,
      nonce,
      signature,
    );

    return { txHash: tx.hash };
  }

  async claimUnlink(address: string, provider: string) {
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
    const tx = await this.contractService.unlink(
      address,
      provider,
      nonce,
      signature,
    );

    return { txHash: tx.hash };
  }

  private validateValue(value: string) {
    if (value.includes(':')) {
      throw new BadRequestException('Value must not contain ":"');
    }
  }
}
