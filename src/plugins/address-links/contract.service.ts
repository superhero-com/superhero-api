import { AeSdkService } from '@/ae/ae-sdk.service';
import { Contract, MemoryAccount } from '@aeternity/aepp-sdk';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
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
    try {
      const result: any = await contract.get_nonce(address);
      return Number(result?.decodedResult ?? result);
    } catch (error) {
      throw this.mapReadError(error, 'get_nonce');
    }
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

  buildLinkMessageForPrincipal(
    principal: string,
    provider: string,
    value: string,
    nonce: number,
  ): string {
    return `link:${principal}:${provider}:${value}:${nonce}`;
  }

  buildUnlinkMessageForPrincipal(
    principal: string,
    provider: string,
    nonce: number,
  ): string {
    return `unlink:${principal}:${provider}:${nonce}`;
  }

  async getNoncePrincipal(principal: string, signer: string): Promise<number> {
    const contract = await this.getContractInstance();
    try {
      const result: any = await contract.get_nonce_principal(principal, signer);
      return Number(result?.decodedResult ?? result);
    } catch (error) {
      throw this.mapReadError(error, 'get_nonce_principal');
    }
  }

  async getLink(address: string, provider: string): Promise<string | null> {
    const contract = await this.getContractInstance();
    let result: any;
    try {
      result = await contract.get_link(address, provider);
    } catch (error) {
      throw this.mapReadError(error, 'get_link');
    }
    const value = result?.decodedResult ?? result;
    if (value === undefined || value === null || value === false) {
      return null;
    }
    return String(value);
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

  async linkPrincipal(
    principal: string,
    signer: string,
    provider: string,
    value: string,
    nonce: number,
    signature: string,
  ) {
    const contract = await this.getContractInstance();
    const sigBuffer = this.decodeSignature(signature);

    try {
      const tx = await contract.link_principal(
        principal,
        signer,
        provider,
        value,
        nonce,
        sigBuffer,
        { onAccount: this.providerAccount! },
      );

      this.logger.log(`Link principal tx: ${tx.hash}`);
      return tx;
    } catch (error) {
      throw this.mapContractError(error, 'link_principal');
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

  async unlinkPrincipal(
    principal: string,
    signer: string,
    provider: string,
    nonce: number,
    signature: string,
  ) {
    const contract = await this.getContractInstance();
    const sigBuffer = this.decodeSignature(signature);

    try {
      const tx = await contract.unlink_principal(
        principal,
        signer,
        provider,
        nonce,
        sigBuffer,
        { onAccount: this.providerAccount! },
      );

      this.logger.log(`Unlink principal tx: ${tx.hash}`);
      return tx;
    } catch (error) {
      throw this.mapContractError(error, 'unlink_principal');
    }
  }

  // Caller-fixable aborts: the request itself is wrong, so a different request
  // succeeds. These map to 400.
  private static readonly CLIENT_CONTRACT_ERRORS: Record<string, string> = {
    INVALID_SIGNATURE:
      'Wallet signature verification failed. Ensure the message was signed with the correct AE account using the signed-message format.',
    INVALID_NONCE:
      'Nonce mismatch. The nonce may have changed — request a new claim and try again.',
    ALREADY_CLAIMED:
      'This provider is already linked to a different value for this address.',
    NO_LINKS: 'No link exists for this provider and address.',
    LINK_NOT_FOUND: 'No link exists for this provider and address.',
    EMPTY_VALUE: 'Value must not be empty.',
    VALUE_TOO_LONG: 'Value must be 200 characters or fewer.',
    INVALID_VALUE: 'Value must not contain ":".',
    EMPTY_PRINCIPAL: 'Principal must not be empty.',
    PRINCIPAL_TOO_LONG: 'Principal must be 200 characters or fewer.',
    PRINCIPAL_NOT_FOUND:
      'AENS name not found. The name must be registered on-chain.',
    PRINCIPAL_MISMATCH:
      'AENS name is not owned by this address. Only the name owner can link or unlink.',
    INVALID_PRINCIPAL: 'Invalid AENS name principal.',
    INVALID_DID: 'Invalid DID. Expected a "did:ae:" principal.',
    MESSAGE_TOO_LONG: 'Signed message is too long.',
    EMPTY_PROVIDER: 'Provider must not be empty.',
    PROVIDER_TOO_LONG: 'Provider must be 10 characters or fewer.',
    INVALID_PROVIDER: 'Provider must contain lowercase letters a–z only.',
    PROVIDER_EXISTS: 'This provider is already registered.',
  };

  // Deployment-wiring aborts: this API instance is not correctly wired to the
  // contract it is pointed at. The caller cannot fix these — a retry succeeds
  // only once the deployment is corrected (e.g. register_provider is run), so
  // they map to 503, matching the env-missing case in getContractInstance().
  private static readonly WIRING_CONTRACT_ERRORS: Record<string, string> = {
    PROVIDER_NOT_FOUND:
      'This provider is not registered on the AddressLink contract this service is configured to use.',
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
      AddressLinksContractService.WIRING_CONTRACT_ERRORS,
    )) {
      if (message.includes(code)) {
        this.logger.error(`Contract ${operation} misconfigured: ${code}`);
        return new ServiceUnavailableException(description);
      }
    }

    for (const [code, description] of Object.entries(
      AddressLinksContractService.CLIENT_CONTRACT_ERRORS,
    )) {
      if (message.includes(code)) {
        this.logger.warn(`Contract ${operation} rejected: ${code}`);
        return new BadRequestException(description);
      }
    }

    // Never re-throw the raw SDK error: it can leak node URLs, tx detail and
    // the backend wallet address through an unauthenticated endpoint. Log it,
    // return a fixed generic 500.
    this.logger.error(`Contract ${operation} failed unexpectedly`, message);
    return new InternalServerErrorException(
      'Address link transaction failed unexpectedly.',
    );
  }

  private mapReadError(error: any, operation: string): Error {
    const mapped = this.mapContractError(error, operation);
    if (mapped instanceof BadRequestException) {
      return mapped;
    }
    return new ServiceUnavailableException(
      'Unable to reach the address-link contract right now, please try again',
    );
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
