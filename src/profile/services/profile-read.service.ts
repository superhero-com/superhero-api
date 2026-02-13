import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Account } from '@/account/entities/account.entity';
import { ProfileCache } from '../entities/profile-cache.entity';
import { OnChainProfile, ProfileContractService } from './profile-contract.service';

interface GetProfileOptions {
  includeOnChain?: boolean;
}

@Injectable()
export class ProfileReadService {
  constructor(
    @InjectRepository(ProfileCache)
    private readonly profileCacheRepository: Repository<ProfileCache>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly profileContractService: ProfileContractService,
  ) {}

  async getProfile(address: string, options: GetProfileOptions = {}) {
    const [cache, account] = await Promise.all([
      this.profileCacheRepository.findOne({ where: { address } }),
      this.accountRepository.findOne({ where: { address } }),
    ]);

    const includeOnChain = options.includeOnChain === true;
    const onChainProfile = includeOnChain
      ? await this.profileContractService.getProfile(address)
      : null;
    const profile = this.mergeProfile(cache, onChainProfile, account);

    const publicName =
      cache?.public_name || this.resolvePublicName(profile, address);
    return {
      address,
      profile,
      public_name: publicName,
      names: {
        custom_name: profile.username || null,
        chain_name: profile.chain_name || null,
        x_name: profile.x_username || null,
      },
    };
  }

  async getOnChainProfile(address: string) {
    const onChainProfile = await this.profileContractService.getProfile(address);
    if (!onChainProfile) {
      return {
        address,
        profile: null,
        public_name: null,
      };
    }

    return {
      address,
      profile: onChainProfile,
      public_name: this.resolvePublicName(onChainProfile, address),
    };
  }

  async getProfilesByAddresses(
    addresses: string[],
    options: GetProfileOptions = {},
  ) {
    const uniqueAddresses = Array.from(
      new Set(
        addresses
          .map((address) => address.trim())
          .filter((address) => address.length > 0),
      ),
    );

    if (uniqueAddresses.length === 0) {
      return [];
    }

    const [caches, accounts] = await Promise.all([
      this.profileCacheRepository.find({
        where: { address: In(uniqueAddresses) },
      }),
      this.accountRepository.find({
        where: { address: In(uniqueAddresses) },
      }),
    ]);

    const cacheByAddress = new Map(caches.map((cache) => [cache.address, cache]));
    const accountByAddress = new Map(
      accounts.map((account) => [account.address, account]),
    );

    return Promise.all(
      uniqueAddresses.map((address) => {
        return this.getProfileFromAggregates(
          address,
          cacheByAddress.get(address) || null,
          accountByAddress.get(address) || null,
          options.includeOnChain === true,
        );
      }),
    );
  }

  async getProfileFeed(limit = 20, offset = 0) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);

    const caches = await this.profileCacheRepository.find({
      order: { updated_at: 'DESC' },
      take: safeLimit,
      skip: safeOffset,
    });

    if (caches.length === 0) {
      return {
        items: [],
        pagination: {
          limit: safeLimit,
          offset: safeOffset,
          count: 0,
        },
      };
    }

    const addresses = caches.map((cache) => cache.address);
    const accounts = await this.accountRepository.find({
      where: { address: In(addresses) },
    });
    const accountByAddress = new Map(
      accounts.map((account) => [account.address, account]),
    );

    const items = caches.map((cache) => {
      const merged = this.mergeProfile(cache, null, accountByAddress.get(cache.address) || null);
      return {
        address: cache.address,
        profile: merged,
        public_name: cache.public_name || this.resolvePublicName(merged, cache.address),
        names: {
          custom_name: merged.username || null,
          chain_name: merged.chain_name || null,
          x_name: merged.x_username || null,
        },
      };
    });

    return {
      items,
      pagination: {
        limit: safeLimit,
        offset: safeOffset,
        count: items.length,
      },
    };
  }

  private async getProfileFromAggregates(
    address: string,
    cache: ProfileCache | null,
    account: Account | null,
    includeOnChain: boolean,
  ) {
    const onChainProfile = includeOnChain
      ? await this.profileContractService.getProfile(address)
      : null;
    const profile = this.mergeProfile(cache, onChainProfile, account);

    return {
      address,
      profile,
      public_name:
        cache?.public_name || this.resolvePublicName(profile, address),
      names: {
        custom_name: profile.username || null,
        chain_name: profile.chain_name || null,
        x_name: profile.x_username || null,
      },
    };
  }

  private mergeProfile(
    cache: ProfileCache | null,
    onChain: OnChainProfile | null,
    account: Account | null,
  ) {
    return {
      fullname: onChain?.fullname ?? cache?.fullname ?? '',
      bio: onChain?.bio ?? cache?.bio ?? account?.bio ?? '',
      avatarurl: onChain?.avatarurl ?? cache?.avatarurl ?? '',
      username: onChain?.username ?? cache?.username ?? null,
      x_username: onChain?.x_username ?? cache?.x_username ?? null,
      chain_name: onChain?.chain_name ?? cache?.chain_name ?? account?.chain_name ?? null,
      display_source: onChain?.display_source ?? cache?.display_source ?? 'custom',
      chain_expires_at: onChain?.chain_expires_at ?? cache?.chain_expires_at ?? null,
    };
  }

  private resolvePublicName(
    profile: {
      username?: string | null;
      x_username?: string | null;
      chain_name?: string | null;
      display_source?: string | null;
    },
    address: string,
  ): string {
    const display = (profile.display_source || '').toLowerCase();
    const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;

    if (display === 'custom' && profile.username) {
      return profile.username;
    }
    if (display === 'chain' && profile.chain_name) {
      return profile.chain_name;
    }
    if (display === 'x' && profile.x_username) {
      return profile.x_username;
    }

    return profile.username || profile.chain_name || profile.x_username || shortAddress;
  }
}
