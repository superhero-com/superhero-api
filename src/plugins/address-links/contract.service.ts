import { AeSdkService } from '@/ae/ae-sdk.service';
import { Contract, MemoryAccount } from '@aeternity/aepp-sdk';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
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
    this.logger.log(
      `AddressLink contract configured at ${this.contractAddress}`,
    );
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

  buildUnlinkMessage(address: string, provider: string, nonce: number): string {
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
    const sigBuffer = this.decodeSignature(signature);

    try {
      const tx = await contract.link(
        address,
        provider,
        value,
        nonce,
        sigBuffer,
        { onAccount: this.providerAccount! },
      );

      this.logger.log(`Link tx: ${tx.hash}`);
      return tx;
    } catch (error) {
      throw this.mapContractError(error, 'link');
    }
  }

  async unlink(
    address: string,
    provider: string,
    nonce: number,
    signature: string,
  ) {
    const contract = await this.getContractInstance();
    const sigBuffer = this.decodeSignature(signature);

    try {
      const tx = await contract.unlink(address, provider, nonce, sigBuffer, {
        onAccount: this.providerAccount!,
      });

      this.logger.log(`Unlink tx: ${tx.hash}`);
      return tx;
    } catch (error) {
      throw this.mapContractError(error, 'unlink');
    }
  }

  private static readonly KNOWN_CONTRACT_ERRORS: Record<string, string> = {
    INVALID_SIGNATURE:
      'Wallet signature verification failed. Ensure the message was signed with the correct AE account using the signed-message format.',
    INVALID_NONCE:
      'Nonce mismatch. The nonce may have changed — request a new claim and try again.',
    ALREADY_CLAIMED:
      'This provider is already linked to a different value for this address.',
    NOT_LINKED: 'No link exists for this provider and address.',
    NOT_PROVIDER_OWNER:
      'The backend wallet is not the registered owner for this provider on the contract.',
  };

  private decodeSignature(hex: string): Buffer {
    if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
      throw new BadRequestException(
        `Invalid signature: expected 128-character hex string (64 bytes), got ${hex.length} characters`,
      );
    }
    return Buffer.from(hex, 'hex');
  }

  private mapContractError(error: any, operation: string): Error {
    const message: string = error?.message || String(error);
    for (const [code, description] of Object.entries(
      AddressLinksContractService.KNOWN_CONTRACT_ERRORS,
    )) {
      if (message.includes(code)) {
        this.logger.warn(`Contract ${operation} rejected: ${code}`);
        return new BadRequestException(description);
      }
    }
    this.logger.error(`Contract ${operation} failed unexpectedly`, message);
    return error;
  }

  private async getContractInstance(): Promise<any> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'AddressLink contract is not configured',
      );
    }
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
      path.join(__dirname, 'aci', fileName),
      path.join(
        process.cwd(),
        'dist',
        'src',
        'plugins',
        'address-links',
        'aci',
        fileName,
      ),
      path.join(
        process.cwd(),
        'dist',
        'plugins',
        'address-links',
        'aci',
        fileName,
      ),
      path.join(
        process.cwd(),
        'src',
        'plugins',
        'address-links',
        'aci',
        fileName,
      ),
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
