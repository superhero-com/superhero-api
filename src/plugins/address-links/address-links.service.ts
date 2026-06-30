import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { AddressLinksContractService } from './contract.service';

@Injectable()
export class AddressLinksService {
  private readonly logger = new Logger(AddressLinksService.name);

  constructor(private readonly contractService: AddressLinksContractService) {}

  buildLinkMessage(
    address: string,
    provider: string,
    value: string,
    nonce: number,
  ): string {
    return this.contractService.buildLinkMessage(
      address,
      provider,
      value,
      nonce,
    );
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

  async claimLinkPrincipal(
    signerAddress: string,
    provider: string,
    principal: string,
    value: string,
  ) {
    this.validateValue(value);

    const nonce = await this.contractService.getNoncePrincipal(
      principal,
      signerAddress,
    );
    const message = this.contractService.buildLinkMessageForPrincipal(
      principal,
      provider,
      value,
      nonce,
    );

    return { message, nonce, value, principal };
  }

  async submitLinkPrincipal(
    signerAddress: string,
    provider: string,
    principal: string,
    value: string,
    nonce: number,
    signature: string,
  ) {
    this.validateValue(value);

    const tx = await this.contractService.linkPrincipal(
      principal,
      signerAddress,
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

  async claimUnlinkPrincipal(signerAddress: string, provider: string) {
    const principal = await this.contractService.getLink(
      signerAddress,
      provider,
    );
    if (!principal) {
      throw new BadRequestException(
        'No link exists for this provider and address.',
      );
    }

    const nonce = await this.contractService.getNoncePrincipal(
      principal,
      signerAddress,
    );
    const message = this.contractService.buildUnlinkMessageForPrincipal(
      principal,
      provider,
      nonce,
    );

    return { message, nonce, value: principal, principal };
  }

  async submitUnlinkPrincipal(
    signerAddress: string,
    provider: string,
    principal: string,
    nonce: number,
    signature: string,
  ) {
    const tx = await this.contractService.unlinkPrincipal(
      principal,
      signerAddress,
      provider,
      nonce,
      signature,
    );

    return { txHash: tx.hash };
  }

  private validateValue(value: string) {
    if (value.length > 200) {
      throw new BadRequestException('Value must be 200 characters or fewer');
    }
    if (value.includes(':')) {
      throw new BadRequestException('Value must not contain ":"');
    }
  }
}
