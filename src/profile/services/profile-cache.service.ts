import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '@/account/entities/account.entity';
import { ProfileCache } from '../entities/profile-cache.entity';

/**
 * Writer for the denormalised `profile_cache` table.
 *
 * Background: `profile_cache` used to be populated by the ProfileRegistry
 * indexer (ProfileIndexerService / ProfileLiveSyncService). Those services were
 * removed when profile linkage moved to the AddressLink contract, which left
 * `profile_cache` with no writer at all. The `profile_cache`-backed consumers —
 * the profile feed (ordered by `updated_at`) and the accounts search (matches
 * `public_name` / `username` / `fullname`) — therefore froze, even though live
 * link data on `accounts.links` keeps changing. Single-profile reads were not
 * affected because {@link ProfileReadService} merges `accounts.links` live.
 *
 * This service re-establishes a writer: whenever a user links/unlinks profile
 * info we refresh the searchable name and bump `updated_at` so the feed
 * re-orders and link-only accounts become visible. Registry-only legacy fields
 * (fullname, avatarurl, username) are no longer sourced by any contract, so
 * they are preserved on update rather than overwritten.
 */
@Injectable()
export class ProfileCacheService {
  private readonly logger = new Logger(ProfileCacheService.name);

  constructor(
    @InjectRepository(ProfileCache)
    private readonly profileCacheRepository: Repository<ProfileCache>,
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  /**
   * Refresh the cache row for an address from its current `accounts` state
   * (links + chain name) and bump `updated_at`. Safe to call on every
   * link/unlink event; the row is created if it does not exist yet so
   * link-only accounts show up in the feed.
   */
  async syncFromAccountLinks(
    address: string,
    microTime?: string,
  ): Promise<void> {
    if (!address) {
      return;
    }

    const [account, existing] = await Promise.all([
      this.accountRepository.findOne({ where: { address } }),
      this.profileCacheRepository.findOne({ where: { address } }),
    ]);

    const publicName = this.resolvePublicName(account, existing);

    try {
      await this.profileCacheRepository.upsert(
        {
          address,
          public_name: publicName,
          last_seen_micro_time:
            microTime ?? existing?.last_seen_micro_time ?? null,
          // Bump explicitly: TypeORM does not touch @UpdateDateColumn on
          // upsert, and the feed orders by this column.
          updated_at: new Date(),
        },
        { conflictPaths: ['address'] },
      );
    } catch (error) {
      this.logger.error(
        `Failed to refresh profile_cache for ${address}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Searchable display name, mirroring {@link ProfileReadService}'s public-name
   * precedence: a user-set preferred AENS name overrides the middleware-derived
   * chain name, then the legacy username. Falls back to null rather than the
   * address, which is already searchable on its own.
   */
  private resolvePublicName(
    account: Account | null,
    existing: ProfileCache | null,
  ): string | null {
    const preferredAens = account?.links?.prefaens?.trim() || null;
    const chainName = account?.chain_name?.trim() || null;
    const username = existing?.username?.trim() || null;
    return preferredAens || chainName || username || null;
  }
}
