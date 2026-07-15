import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigType } from '@nestjs/config';
import { Account } from '@/account/entities/account.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import tgrConfig from '../config/tgr.config';
import { normalizePubkey } from '../nostr/pubkey';
import { IdentityService } from './identity.service';

export interface IdentityBackfillResult {
  /** distinct member addresses scanned */
  scanned: number;
  /** members resolved to a hex pubkey (member_pubkey set) */
  linked: number;
  /** members with no parseable nostr link (member_pubkey null — invariant) */
  unlinked: number;
}

/**
 * One-time AE-address → nostr-pubkey backfill at startup (Task 05 req §4).
 *
 * Iterates the **relevant holders** — distinct `room_membership.member_address`
 * values joined to `accounts` — and resolves `Account.links[<provider>]` to a
 * normalized hex pubkey, seeding {@link IdentityService}'s in-memory cache and
 * writing `room_membership.member_pubkey` for every linked holder.
 *
 * We read `Account.links` **directly** — the reactive link sync already
 * materialized it — so this is a plain DB scan, NOT an MDW-log replay (unlike the
 * bot's `NostrVerifiedAccounts.backfillLinks()`).
 *
 * **Resumable / bounded / idempotent:** the scan is cursor-paginated by
 * `member_address` (`WHERE member_address > :cursor ORDER BY member_address ASC
 * LIMIT :N`) so a large membership table never loads in one query, and re-running
 * converges to the same state (every write is the normalized value, null for
 * unlinked — honoring the unlinked-but-eligible invariant §6.6).
 */
@Injectable()
export class IdentityBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdentityBackfillService.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    @InjectRepository(RoomMembership)
    private readonly membershipRepo: Repository<RoomMembership>,
    private readonly identityService: IdentityService,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.run();
      this.logger.log(
        `[identity-backfill] complete: scanned=${result.scanned} linked=${result.linked} unlinked=${result.unlinked}`,
      );
    } catch (error: any) {
      // Never crash startup on a backfill error — the reactive path + the
      // hot-path DB fall-through still keep resolution correct; a later restart
      // re-runs the backfill (it is idempotent).
      this.logger.error(
        `[identity-backfill] failed: ${error?.message ?? error}`,
      );
    }
  }

  /**
   * Run the backfill to completion. Pages through distinct member addresses,
   * resolves each link, seeds the cache, and writes `member_pubkey`.
   *
   * @param options.batchSize override the configured batch size (tests).
   */
  async run(
    options: { batchSize?: number } = {},
  ): Promise<IdentityBackfillResult> {
    const batchSize = options.batchSize ?? this.config.backfillBatchSize;
    const result: IdentityBackfillResult = {
      scanned: 0,
      linked: 0,
      unlinked: 0,
    };

    let cursor = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const addresses = await this.nextMemberBatch(cursor, batchSize);
      if (addresses.length === 0) break;

      // Resolve each address' link from `accounts.links` in this page.
      const links = await this.loadLinks(addresses);

      for (const address of addresses) {
        result.scanned += 1;
        const hex = normalizePubkey(links.get(address));
        if (hex) {
          this.identityService.setCacheEntry(address, hex);
          await this.membershipRepo.update(
            { member_address: address },
            { member_pubkey: hex },
          );
          result.linked += 1;
        } else {
          // Unlinked / unparseable: enforce the §6.6 invariant — member_pubkey
          // stays null. We never persist a malformed pubkey, and we do NOT touch
          // eligibility/relay_state (Task 06/10 own those).
          this.identityService.clearCacheEntry(address);
          await this.membershipRepo.update(
            { member_address: address },
            { member_pubkey: null },
          );
          result.unlinked += 1;
        }
      }

      cursor = addresses[addresses.length - 1];
      if (addresses.length < batchSize) break;
    }

    return result;
  }

  /**
   * Next page of distinct `member_address` values present in `room_membership`
   * AND `accounts`, ordered ascending for a stable cursor. Inner-joining
   * `accounts` excludes orphan membership rows whose account row was never
   * created (their links would be unresolvable anyway).
   */
  private async nextMemberBatch(
    cursor: string,
    batchSize: number,
  ): Promise<string[]> {
    const rows = await this.membershipRepo
      .createQueryBuilder('m')
      .innerJoin(Account, 'a', 'a.address = m.member_address')
      .select('m.member_address', 'member_address')
      .where('m.member_address > :cursor', { cursor })
      .groupBy('m.member_address')
      .orderBy('m.member_address', 'ASC')
      .limit(batchSize)
      .getRawMany<{ member_address: string }>();
    return rows.map((r) => r.member_address);
  }

  /** Bulk-load `links` for a page of addresses → `address → links[provider]`. */
  private async loadLinks(
    addresses: string[],
  ): Promise<Map<string, string | undefined>> {
    const accounts = await this.accountRepo.find({
      where: addresses.map((address) => ({ address })),
      select: ['address', 'links'],
    });
    const provider = this.identityService.provider;
    const map = new Map<string, string | undefined>();
    for (const account of accounts) {
      map.set(account.address, account.links?.[provider]);
    }
    return map;
  }
}
