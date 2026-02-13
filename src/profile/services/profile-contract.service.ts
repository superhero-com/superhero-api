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
        display_source:
          typeof profile.display_source === 'string'
            ? profile.display_source
            : profile.display_source?.toString?.() || null,
        chain_expires_at: this.unwrapOption(profile.chain_expires_at)?.toString?.() || null,
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

  private async getContractInstance(): Promise<any> {
    const sourcePath = path.resolve(
      process.cwd(),
      'contracts/profile-registry/contracts/ProfileRegistry_v1.aes',
    );
    const sourceCode = fs.readFileSync(sourcePath, 'utf-8');
    return this.aeSdkService.sdk.initializeContract({
      sourceCode,
      address: this.contractAddress as `ct_${string}`,
    });
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
}
