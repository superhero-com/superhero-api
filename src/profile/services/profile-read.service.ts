import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Account } from '@/account/entities/account.entity';
import { ProfileCache } from '../entities/profile-cache.entity';

@Injectable()
export class ProfileReadService {
  constructor(
    @InjectRepository(ProfileCache)
    private readonly profileCacheRepository: Repository<ProfileCache>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  async getProfile(address: string) {
    const [cache, account] = await Promise.all([
      this.profileCacheRepository.findOne({ where: { address } }),
      this.accountRepository.findOne({ where: { address } }),
    ]);

    const profile = this.mergeProfile(cache, account);

    const publicName = this.resolvePublicName(profile, address);
    return {
      address,
      profile,
      public_name: publicName,
    };
  }

  async getProfilesByAddresses(addresses: string[]) {
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

    const cacheByAddress = new Map(
      caches.map((cache) => [cache.address, cache]),
    );
    const accountByAddress = new Map(
      accounts.map((account) => [account.address, account]),
    );

    return Promise.all(
      uniqueAddresses.map((address) => {
        return this.getProfileFromAggregates(
          address,
          cacheByAddress.get(address) || null,
          accountByAddress.get(address) || null,
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
      const merged = this.mergeProfile(
        cache,
        accountByAddress.get(cache.address) || null,
      );
      return {
        address: cache.address,
        profile: merged,
        public_name: this.resolvePublicName(merged, cache.address),
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
  ) {
    const profile = this.mergeProfile(cache, account);

    return {
      address,
      profile,
      public_name: this.resolvePublicName(profile, address),
    };
  }

  private mergeProfile(cache: ProfileCache | null, account: Account | null) {
    return {
      fullname: cache?.fullname ?? '',
      bio: this.getLinkedBio(account) ?? cache?.bio ?? '',
      avatarurl: cache?.avatarurl ?? '',
      username: cache?.username ?? null,
      x_username: this.getLinkedXUsername(account),
      chain_name: cache?.chain_name ?? account?.chain_name ?? null,
      chain_expires_at: cache?.chain_expires_at ?? null,
    };
  }

  private resolvePublicName(
    profile: {
      username?: string | null;
      x_username?: string | null;
      chain_name?: string | null;
    },
    address: string,
  ): string {
    if (profile.chain_name) {
      return profile.chain_name;
    }
    return profile.username || address;
  }

  private getLinkedXUsername(account: Account | null): string | null {
    const linked = account?.links?.x;
    return linked ? linked.trim().toLowerCase().replace(/^@+/, '') : null;
  }

  private getLinkedBio(account: Account | null): string | null {
    const linked = account?.links?.bio;
    return linked ? linked.trim() : null;
  }
}
