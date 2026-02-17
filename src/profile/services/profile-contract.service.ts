import { AeSdkService } from '@/ae/ae-sdk.service';
import { Injectable, Logger } from '@nestjs/common';
import fs from 'fs';
import path from 'path';
import { PROFILE_REGISTRY_CONTRACT_ADDRESS } from '../profile.constants';

export interface OnChainProfile {
  fullname: string;
  bio: string;
  avatarurl: string;
  username?: string | null;
  x_username?: string | null;
  chain_name?: string | null;
  display_source?: string | null;
  chain_expires_at?: string | null;
}

@Injectable()
export class ProfileContractService {
  private readonly logger = new Logger(ProfileContractService.name);
  private readonly contractAddress = PROFILE_REGISTRY_CONTRACT_ADDRESS;
  private readonly aciFileName = 'ProfileRegistryACI.json';
  private cachedAci: any | null = null;
  private cachedContract: any | null = null;

  constructor(private readonly aeSdkService: AeSdkService) {}

  getContractAddress(): string {
    return this.contractAddress;
  }

  isConfigured(): boolean {
    return Boolean(this.contractAddress);
  }

  async getProfile(address: string): Promise<OnChainProfile | null> {
    if (!this.contractAddress) {
      return null;
    }

    try {
      const contract = await this.getContractInstance();
      const result: any = await contract.get_profile(address);
      const decoded = result?.decodedResult ?? result;

      if (!decoded) {
        return null;
      }

      // SDK can decode option(T) as null or object depending on version/config.
      const profile = decoded.Some ?? decoded;
      if (!profile || profile.None !== undefined) {
        return null;
      }

      return {
        fullname: profile.fullname || '',
        bio: profile.bio || '',
        avatarurl: profile.avatarurl || '',
        username: this.unwrapOption(profile.username),
        x_username: this.unwrapOption(profile.x_username),
        chain_name: this.unwrapOption(profile.chain_name),
        display_source: this.normalizeDisplaySource(profile.display_source),
        chain_expires_at:
          this.unwrapOption(profile.chain_expires_at)?.toString?.() || null,
      };
    } catch (error) {
      this.logger.error(`Failed to read profile for ${address}`, error);
      return null;
    }
  }

  async resolvePublicName(name: string): Promise<string | null> {
    if (!this.contractAddress) {
      return null;
    }

    try {
      const contract = await this.getContractInstance();
      const result: any = await contract.resolve_public_name(name);
      const decoded = result?.decodedResult ?? result;
      const owner = decoded?.Some ?? decoded;
      if (!owner || owner.None !== undefined) {
        return null;
      }
      return owner.toString();
    } catch (error) {
      this.logger.error(`Failed to resolve public name ${name}`, error);
      return null;
    }
  }

  async decodeEvents(
    rawLog: any,
  ): Promise<Array<{ name?: string; args?: any[] }>> {
    if (!rawLog || !Array.isArray(rawLog) || rawLog.length === 0) {
      return [];
    }
    if (!this.contractAddress) {
      return [];
    }
    try {
      const contract = await this.getContractInstance();
      const decoded = contract.$decodeEvents(rawLog);
      return Array.isArray(decoded) ? decoded : [];
    } catch (error) {
      this.logger.warn('Failed to decode profile contract events');
      return [];
    }
  }

  private async getContractInstance(): Promise<any> {
    if (this.cachedContract) {
      return this.cachedContract;
    }
    if (!this.cachedAci) {
      const aciPath = this.resolveAciPath();
      this.cachedAci = JSON.parse(fs.readFileSync(aciPath, 'utf-8'));
    }
    this.cachedContract = await this.aeSdkService.sdk.initializeContract({
      aci: this.cachedAci,
      address: this.contractAddress as `ct_${string}`,
    });
    return this.cachedContract;
  }

  private resolveAciPath(): string {
    const fileName = this.aciFileName;
    const candidatePaths = [
      // Typical runtime path (works in ts-jest and some dist layouts).
      path.join(__dirname, '..', 'contract', fileName),
      // Nested dist path: dist/src/profile/services -> dist/profile/contract
      path.join(__dirname, '..', '..', '..', 'profile', 'contract', fileName),
      // Explicit CWD-based fallbacks for different build setups.
      path.join(process.cwd(), 'dist', 'src', 'profile', 'contract', fileName),
      path.join(process.cwd(), 'dist', 'profile', 'contract', fileName),
      path.join(process.cwd(), 'src', 'profile', 'contract', fileName),
    ];

    const existingPath = candidatePaths.find((candidatePath) =>
      fs.existsSync(candidatePath),
    );
    if (existingPath) {
      return existingPath;
    }

    throw new Error(
      `Profile contract ACI file not found. Searched: ${candidatePaths.join(', ')}`,
    );
  }

  private unwrapOption(value: any): any {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, 'None')) {
        return null;
      }
      if (Object.prototype.hasOwnProperty.call(value, 'Some')) {
        return value.Some;
      }
    }
    return value;
  }

  private normalizeDisplaySource(value: any): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (
        normalized === 'custom' ||
        normalized === 'chain' ||
        normalized === 'x'
      ) {
        return normalized;
      }
      return null;
    }
    // Sophia variant can decode as object like { Custom: [] } / { Chain: [] } / { X: [] }
    if (typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, 'Custom'))
        return 'custom';
      if (Object.prototype.hasOwnProperty.call(value, 'Chain')) return 'chain';
      if (Object.prototype.hasOwnProperty.call(value, 'X')) return 'x';
      if (Object.prototype.hasOwnProperty.call(value, 'tag')) {
        const tagValue = String((value as any).tag || '').toLowerCase();
        if (tagValue === 'custom' || tagValue === 'chain' || tagValue === 'x') {
          return tagValue;
        }
      }
    }
    return null;
  }
}
