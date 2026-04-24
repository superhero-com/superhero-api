import { Tx } from '@/mdw-sync/entities/tx.entity';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

/**
 * Tracks the set of poll contract addresses the governance registry has
 * registered via `add_poll`. This is consumed by:
 *
 *   1. `GovernancePlugin.filters()` — decides whether a
 *      `ContractCallTx (vote / revoke_vote)` or `ContractCreateTx` targeting a
 *      specific contract should be persisted.
 *   2. `GovernancePluginSyncService` — registers newly discovered polls and
 *      backfills their `ContractCreateTx` when `add_poll` is decoded.
 *
 * We cannot identify poll contracts in advance from the raw tx stream, so we
 * start from whatever is already stored in `txs` (previous `add_poll` data)
 * and grow the set as new `add_poll` events are processed.
 */
@Injectable()
export class GovernancePollRegistry implements OnModuleInit {
  private readonly logger = new Logger(GovernancePollRegistry.name);
  private readonly pollAddresses = new Set<string>();
  private loaded = false;

  constructor(
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadFromDb();
  }

  /**
   * Seed the in-memory set from whatever governance data is already present
   * in `txs`. Safe to call multiple times; errors are swallowed so indexer
   * startup cannot be blocked by a transient DB issue — new polls will still
   * be picked up lazily via `register()` as `add_poll` events arrive.
   */
  private async loadFromDb(): Promise<void> {
    try {
      const rows = await this.txRepository
        .createQueryBuilder('tx')
        .select(
          `tx.data->'governance'->'data'->>'poll_address'`,
          'poll_address',
        )
        .where(`tx.function = :fn`, { fn: 'add_poll' })
        .andWhere(`tx.data->'governance'->'data'->>'poll_address' IS NOT NULL`)
        .distinct(true)
        .getRawMany<{ poll_address: string }>();

      for (const row of rows) {
        if (row.poll_address) {
          this.pollAddresses.add(row.poll_address);
        }
      }

      this.loaded = true;
      this.logger.log(
        `Loaded ${this.pollAddresses.size} known poll addresses from existing data`,
      );
    } catch (error: any) {
      this.logger.error(
        'Failed to preload known poll addresses (continuing with empty set — polls will be registered as they are discovered)',
        error?.stack ?? error,
      );
    }
  }

  /**
   * Add a newly discovered poll address.
   *
   * @returns `true` if this call added a new address (caller may need to run
   *          any one-time backfill work for this poll); `false` if the
   *          address was already known — either from the startup DB load or
   *          from a previous `register()` call in this session.
   */
  register(pollAddress: string | null | undefined): boolean {
    if (!pollAddress) {
      return false;
    }
    if (this.pollAddresses.has(pollAddress)) {
      return false;
    }
    this.pollAddresses.add(pollAddress);
    this.logger.debug(`Registered poll address ${pollAddress}`);
    return true;
  }

  has(pollAddress: string | null | undefined): boolean {
    return !!pollAddress && this.pollAddresses.has(pollAddress);
  }

  size(): number {
    return this.pollAddresses.size;
  }

  /** Whether the initial DB load completed. Useful for diagnostics only. */
  isLoaded(): boolean {
    return this.loaded;
  }
}
