import { AeSdkService } from '@/ae/ae-sdk.service';
import { Contract, MemoryAccount } from '@aeternity/aepp-sdk';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import fs from 'fs';
import path from 'path';
import {
  ADDRESS_LINK_CONTRACT_ADDRESS,
  ADDRESS_LINK_SECRET_KEY,
} from './address-links.constants';

@Injectable()
export class AddressLinksContractService implements OnModuleInit {
  private readonly logger = new Logger(AddressLinksContractService.name);
  private readonly contractAddress = ADDRESS_LINK_CONTRACT_ADDRESS;
  private readonly aciFileName = 'AddressLink.aci.json';
  private cachedAci: any | null = null;
  private cachedContract: any | null = null;
  private providerAccount: MemoryAccount | null = null;

  constructor(private readonly aeSdkService: AeSdkService) {}

  async onModuleInit() {
    if (!this.isConfigured()) {
      this.logger.warn(
        'AddressLink contract is not configured (ADDRESS_LINK_CONTRACT_ADDRESS or ADDRESS_LINK_SECRET_KEY missing)',
      );
      return;
    }
    this.providerAccount = new MemoryAccount(ADDRESS_LINK_SECRET_KEY as any);
    this.logger.log(`AddressLink contract configured at ${this.contractAddress}`);
  }

  isConfigured(): boolean {
    return Boolean(this.contractAddress && ADDRESS_LINK_SECRET_KEY);
  }

  async getNonce(address: string): Promise<number> {
    const contract = await this.getContractInstance();
    const result: any = await contract.get_nonce(address);
    return Number(result?.decodedResult ?? result);
  }

  buildLinkMessage(
    address: string,
    provider: string,
    value: string,
    nonce: number,
  ): string {
    return `link:${address}:${provider}:${value}:${nonce}`;
  }

  buildUnlinkMessage(
    address: string,
    provider: string,
    nonce: number,
  ): string {
    return `unlink:${address}:${provider}:${nonce}`;
  }

  async link(
    address: string,
    provider: string,
    value: string,
    nonce: number,
    signature: string,
  ) {
    const contract = await this.getContractInstance();
    const sigBuffer = Buffer.from(signature, 'hex');

    const tx = await contract.link(address, provider, value, nonce, sigBuffer, {
      onAccount: this.providerAccount!,
    });

    this.logger.log(`Link tx: ${tx.hash}`);
    return tx;
  }

  async unlink(
    address: string,
    provider: string,
    nonce: number,
    signature: string,
  ) {
    const contract = await this.getContractInstance();
    const sigBuffer = Buffer.from(signature, 'hex');

    const tx = await contract.unlink(address, provider, nonce, sigBuffer, {
      onAccount: this.providerAccount!,
    });

    this.logger.log(`Unlink tx: ${tx.hash}`);
    return tx;
  }

  async getLinks(address: string): Promise<Record<string, string>> {
    const contract = await this.getContractInstance();
    const result: any = await contract.get_links(address);
    const decoded = result?.decodedResult ?? result;
    const links: Record<string, string> = {};
    if (decoded instanceof Map) {
      decoded.forEach((value: string, key: string) => {
        links[key] = value;
      });
    }
    return links;
  }

  private async getContractInstance(): Promise<any> {
    if (this.cachedContract) {
      return this.cachedContract;
    }
    if (!this.cachedAci) {
      const aciPath = this.resolveAciPath();
      this.cachedAci = JSON.parse(fs.readFileSync(aciPath, 'utf-8'));
    }
    this.cachedContract = await Contract.initialize({
      ...this.aeSdkService.sdk.getContext(),
      aci: this.cachedAci,
      address: this.contractAddress as `ct_${string}`,
    });
    return this.cachedContract;
  }

  private resolveAciPath(): string {
    const fileName = this.aciFileName;
    const candidatePaths = [
      path.join(__dirname, '..', 'address-links', 'aci', fileName),
      path.join(__dirname, 'aci', fileName),
      path.join(process.cwd(), 'dist', 'src', 'address-links', 'aci', fileName),
      path.join(process.cwd(), 'dist', 'address-links', 'aci', fileName),
      path.join(process.cwd(), 'src', 'address-links', 'aci', fileName),
    ];

    const existingPath = candidatePaths.find((candidatePath) =>
      fs.existsSync(candidatePath),
    );
    if (existingPath) {
      return existingPath;
    }

    throw new Error(
      `AddressLink ACI file not found. Searched: ${candidatePaths.join(', ')}`,
    );
  }
}
