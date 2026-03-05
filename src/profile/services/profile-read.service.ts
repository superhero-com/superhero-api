import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ACTIVE_NETWORK } from '@/configs';
import { fetchJson } from '@/utils/common';
import { Account } from '@/account/entities/account.entity';
import { ProfileCache } from '../entities/profile-cache.entity';
import { PROFILE_MUTATION_FUNCTIONS } from '../profile.constants';
import {
  OnChainProfile,
  ProfileContractService,
} from './profile-contract.service';

interface GetProfileOptions {
  includeOnChain?: boolean;
}

@Injectable()
export class ProfileReadService {
  private readonly logger = new Logger(ProfileReadService.name);
  private static readonly PROFILE_MUTATION_FUNCTIONS = new Set<string>(
    PROFILE_MUTATION_FUNCTIONS,
  );
  private recentChangedAddressesCache: {
    addresses: string[];
    expiresAt: number;
  } | null = null;
  private recentChangedAddressesInFlight: {
    targetUnique: number;
    promise: Promise<string[]>;
  } | null = null;
  private readonly recentChangedAddressesTtlMs = 15_000;

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
    // For single-profile reads, fallback to on-chain when cache is missing/empty.
    const shouldFallbackToOnChain =
      includeOnChain || !cache || this.isCacheEffectivelyEmpty(cache);
    const onChainProfile = shouldFallbackToOnChain
      ? await this.profileContractService.getProfile(address)
      : null;
    const profile = this.mergeProfile(cache, onChainProfile, account);

    const publicName = onChainProfile
      ? this.resolvePublicName(profile)
      : (cache?.public_name ?? this.resolvePublicName(profile));
    if (onChainProfile) {
      await this.saveProfileCacheSnapshot(address, profile, publicName);
    }
    return {
      address,
      profile,
      public_name: publicName,
    };
  }

  async getOnChainProfile(address: string) {
    const onChainProfile =
      await this.profileContractService.getProfile(address);
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
      public_name: this.resolvePublicName(onChainProfile),
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
      let fallbackItems: Array<{
        address: string;
        profile: {
          fullname: string;
          bio: string;
          avatarurl: string;
          username: string | null;
          x_username: string | null;
          chain_name: string | null;
          display_source: string;
          chain_expires_at: string | null;
        };
        public_name: string;
      }> = [];
      try {
        fallbackItems = await this.buildFeedFromOnChainFallback(
          safeLimit,
          safeOffset,
        );
      } catch (error) {
        this.logger.warn(
          'Failed to build profile feed from on-chain fallback',
          error,
        );
      }
      return {
        items: fallbackItems,
        pagination: {
          limit: safeLimit,
          offset: safeOffset,
          count: fallbackItems.length,
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
        null,
        accountByAddress.get(cache.address) || null,
      );
      return {
        address: cache.address,
        profile: merged,
        public_name: cache.public_name ?? this.resolvePublicName(merged),
      };
    });

    // If cache page is underfilled, top up from recent middleware-derived addresses.
    // This avoids empty/near-empty feeds when indexer cache hasn't fully backfilled yet.
    if (items.length < safeLimit) {
      try {
        const fallbackItems = await this.buildFeedFromOnChainFallback(
          safeLimit - items.length,
          0,
          new Set(items.map((item) => item.address)),
        );
        items.push(...fallbackItems);
      } catch (error) {
        this.logger.warn(
          'Failed to top up profile feed from on-chain fallback',
          error,
        );
      }
    }

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
    const shouldFallbackToOnChain =
      includeOnChain || !cache || this.isCacheEffectivelyEmpty(cache);
    const onChainProfile = shouldFallbackToOnChain
      ? await this.profileContractService.getProfile(address)
      : null;
    const profile = this.mergeProfile(cache, onChainProfile, account);

    return {
      address,
      profile,
      public_name: onChainProfile
        ? this.resolvePublicName(profile)
        : (cache?.public_name ?? this.resolvePublicName(profile)),
    };
  }

  private mergeProfile(
    cache: ProfileCache | null,
    onChain: OnChainProfile | null,
    account: Account | null,
  ) {
    const normalizedDisplaySource = this.normalizeDisplaySource(
      onChain?.display_source ?? cache?.display_source ?? null,
    );
    return {
      fullname: onChain?.fullname ?? cache?.fullname ?? '',
      bio: onChain?.bio ?? cache?.bio ?? '',
      avatarurl: onChain?.avatarurl ?? cache?.avatarurl ?? '',
      username: onChain?.username ?? cache?.username ?? null,
      x_username: onChain?.x_username ?? cache?.x_username ?? null,
      chain_name:
        onChain?.chain_name ?? cache?.chain_name ?? account?.chain_name ?? null,
      display_source: normalizedDisplaySource || 'custom',
      chain_expires_at:
        onChain?.chain_expires_at ?? cache?.chain_expires_at ?? null,
    };
  }

  private resolvePublicName(profile: {
    username?: string | null;
    x_username?: string | null;
    chain_name?: string | null;
    display_source?: string | null;
  }): string {
    // Business rule: only custom and chain names are user-selectable.
    // If chain name exists, it must be the public name.
    if (profile.chain_name) {
      return profile.chain_name;
    }
    return profile.username || '';
  }

  private isCacheEffectivelyEmpty(cache: ProfileCache): boolean {
    return (
      !cache.fullname &&
      !cache.bio &&
      !cache.avatarurl &&
      !cache.username &&
      !cache.x_username &&
      !cache.chain_name
    );
  }

  private normalizeDisplaySource(
    value: string | null | undefined,
  ): string | null {
    if (!value) {
      return null;
    }
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

  private async buildFeedFromOnChainFallback(
    limit: number,
    offset: number,
    excludeAddresses: Set<string> = new Set(),
  ) {
    // Cache can be empty if the indexer hasn't backfilled yet.
    // In that case, derive candidate addresses from middleware contract calls first,
    // then read only those addresses on-chain.
    const candidates = await this.getRecentChangedAddressesFromMiddleware(
      Math.max((offset + limit) * 8, limit * 4),
    );
    if (candidates.length === 0) {
      return [];
    }

    const accounts = await this.accountRepository.find({
      where: { address: In(candidates) },
    });
    const accountByAddress = new Map(
      accounts.map((account) => [account.address, account]),
    );

    const itemsWithIndex: Array<{
      index: number;
      item: {
        address: string;
        profile: {
          fullname: string;
          bio: string;
          avatarurl: string;
          username: string | null;
          x_username: string | null;
          chain_name: string | null;
          display_source: string;
          chain_expires_at: string | null;
        };
        public_name: string;
      };
      snapshot: ProfileCache;
    }> = [];
    const candidateSubset = candidates
      .slice(offset)
      .filter((address) => !excludeAddresses.has(address));
    const maxConcurrency = Math.min(5, candidateSubset.length, limit);
    let nextIndex = 0;
    let collectedCount = 0;

    const runWorker = async () => {
      while (true) {
        if (collectedCount >= limit) {
          return;
        }
        const candidateIndex = nextIndex;
        nextIndex += 1;
        if (candidateIndex >= candidateSubset.length) {
          return;
        }

        const address = candidateSubset[candidateIndex];
        const account = accountByAddress.get(address) || null;
        let onChain: OnChainProfile | null = null;
        try {
          onChain = await this.profileContractService.getProfile(address);
        } catch (error) {
          this.logger.warn(`Feed fallback failed for ${address}`, error);
          continue;
        }
        if (!onChain || this.isOnChainProfileEffectivelyEmpty(onChain)) {
          continue;
        }

        if (collectedCount >= limit) {
          return;
        }

        const merged = this.mergeProfile(null, onChain, account);
        const publicName = this.resolvePublicName(merged);
        collectedCount += 1;
        itemsWithIndex.push({
          index: candidateIndex,
          item: {
            address,
            profile: merged,
            public_name: publicName,
          },
          snapshot: this.toProfileCacheSnapshot(address, merged, publicName),
        });
      }
    };

    await Promise.all(
      Array.from({ length: maxConcurrency }, () => runWorker()),
    );

    itemsWithIndex.sort((left, right) => left.index - right.index);
    const selected = itemsWithIndex.slice(0, limit);
    const items: Array<{
      address: string;
      profile: {
        fullname: string;
        bio: string;
        avatarurl: string;
        username: string | null;
        x_username: string | null;
        chain_name: string | null;
        display_source: string;
        chain_expires_at: string | null;
      };
      public_name: string;
    }> = selected.map((entry) => entry.item);
    const toCache = selected.map((entry) => entry.snapshot);

    if (toCache.length > 0) {
      // Keep cache writes out of the hot response path.
      void this.profileCacheRepository
        .upsert(toCache, {
          conflictPaths: ['address'],
        })
        .catch((error) => {
          this.logger.warn(
            'Failed to persist profile feed fallback cache snapshots',
            error,
          );
        });
    }

    return items;
  }

  private async getRecentChangedAddressesFromMiddleware(
    targetUnique: number,
  ): Promise<string[]> {
    if (targetUnique <= 0) {
      return [];
    }
    if (
      typeof this.profileContractService.isConfigured !== 'function' ||
      !this.profileContractService.isConfigured()
    ) {
      return [];
    }

    const now = Date.now();
    const cached = this.recentChangedAddressesCache;
    if (
      cached &&
      cached.expiresAt > now &&
      cached.addresses.length >= targetUnique
    ) {
      return cached.addresses.slice(0, targetUnique);
    }
    if (this.recentChangedAddressesInFlight) {
      const inFlight = this.recentChangedAddressesInFlight;
      const inFlightAddresses = await inFlight.promise;
      if (inFlightAddresses.length >= targetUnique) {
        return inFlightAddresses.slice(0, targetUnique);
      }
      // A larger request arrived while a smaller fetch was in-flight.
      // Continue below and fetch up to targetUnique to avoid truncated fallback pages.
    }

    const fetchPromise =
      this.fetchRecentChangedAddressesFromMiddleware(targetUnique);
    this.recentChangedAddressesInFlight = {
      targetUnique,
      promise: fetchPromise,
    };
    try {
      const addresses = await fetchPromise;
      this.recentChangedAddressesCache = {
        addresses,
        expiresAt: now + this.recentChangedAddressesTtlMs,
      };
      return addresses.slice(0, targetUnique);
    } finally {
      this.recentChangedAddressesInFlight = null;
    }
  }

  private async fetchRecentChangedAddressesFromMiddleware(
    targetUnique: number,
  ): Promise<string[]> {
    const middlewareUrl = ACTIVE_NETWORK.middlewareUrl;
    const contractAddress = this.profileContractService.getContractAddress();
    let endpoint = `${middlewareUrl}/v3/transactions?type=contract_call&contract=${contractAddress}&direction=backward&limit=100`;
    let safetyCounter = 0;
    const maxPages = 30;
    const addresses: string[] = [];
    const seen = new Set<string>();

    while (
      endpoint &&
      safetyCounter < maxPages &&
      addresses.length < targetUnique
    ) {
      safetyCounter += 1;
      let response: any;
      try {
        response = await fetchJson<any>(endpoint, undefined, true);
      } catch (error) {
        this.logger.warn(
          'Failed to fetch profile tx page from middleware',
          error,
        );
        break;
      }
      const txs = response?.data || [];
      for (const tx of txs) {
        const fn = this.extractTxFunction(tx);
        if (!ProfileReadService.PROFILE_MUTATION_FUNCTIONS.has(fn)) {
          continue;
        }
        const caller = this.extractTxCaller(tx);
        if (!caller || seen.has(caller)) {
          continue;
        }
        seen.add(caller);
        addresses.push(caller);
        if (addresses.length >= targetUnique) {
          break;
        }
      }

      if (!response?.next || addresses.length >= targetUnique) {
        break;
      }
      endpoint = response.next.startsWith('http')
        ? response.next
        : `${middlewareUrl}${response.next}`;
    }

    return addresses;
  }

  private isOnChainProfileEffectivelyEmpty(profile: OnChainProfile): boolean {
    return (
      !profile.fullname &&
      !profile.bio &&
      !profile.avatarurl &&
      !profile.username &&
      !profile.x_username &&
      !profile.chain_name
    );
  }

  private extractTxFunction(tx: any): string {
    return (
      tx?.function?.toString?.() ||
      tx?.tx?.function?.toString?.() ||
      tx?.tx?.tx?.function?.toString?.() ||
      tx?.call_info?.function?.toString?.() ||
      ''
    );
  }

  private extractTxCaller(tx: any): string | null {
    return (
      tx?.caller_id?.toString?.() ||
      tx?.tx?.caller_id?.toString?.() ||
      tx?.tx?.tx?.caller_id?.toString?.() ||
      tx?.call_info?.caller_id?.toString?.() ||
      null
    );
  }

  private toProfileCacheSnapshot(
    address: string,
    merged: {
      fullname: string;
      bio: string;
      avatarurl: string;
      username: string | null;
      x_username: string | null;
      chain_name: string | null;
      display_source: string;
      chain_expires_at: string | null;
    },
    publicName: string,
  ): ProfileCache {
    return {
      address,
      fullname: merged.fullname,
      bio: merged.bio,
      avatarurl: merged.avatarurl,
      username: merged.username,
      x_username: merged.x_username,
      chain_name: merged.chain_name,
      display_source: merged.display_source,
      chain_expires_at: merged.chain_expires_at,
      public_name: publicName,
      last_seen_micro_time: null,
    } as ProfileCache;
  }

  private async saveProfileCacheSnapshot(
    address: string,
    merged: {
      fullname: string;
      bio: string;
      avatarurl: string;
      username: string | null;
      x_username: string | null;
      chain_name: string | null;
      display_source: string;
      chain_expires_at: string | null;
    },
    publicName: string,
  ) {
    await this.profileCacheRepository.upsert(
      this.toProfileCacheSnapshot(address, merged, publicName),
      {
        conflictPaths: ['address'],
      },
    );
  }
}
