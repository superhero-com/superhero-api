import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '@/account/entities/account.entity';
import { microTimeToDate } from '@/mdw-sync/utils/common';
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
    const lastSeenMicroTime =
      microTime ?? existing?.last_seen_micro_time ?? null;

    try {
      await this.profileCacheRepository.upsert(
        {
          address,
          public_name: publicName,
          last_seen_micro_time: lastSeenMicroTime,
          // Derive from the on-chain event time, not wall-clock now: the feed
          // orders by this column, so stamping it with the processing time
          // would scramble feed order during a historical backfill (every
          // replayed event would sort as "just now"). TypeORM does not touch
          // @UpdateDateColumn on upsert, so it must be set explicitly.
          updated_at: this.resolveEventTime(lastSeenMicroTime),
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
   * Resolve the feed-ordering timestamp from the event's micro_time.
   * micro_time is microseconds since the epoch, so it must be scaled to
   * milliseconds (see {@link microTimeToDate}) before constructing a Date;
   * passing it raw would land updated_at thousands of years in the future and
   * on a different scale than the wall-clock fallback. Falls back to
   * wall-clock now only when no usable time is available, so live events still
   * surface at the top.
   */
  private resolveEventTime(microTime: string | null): Date {
    return microTimeToDate(microTime) ?? new Date();
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
