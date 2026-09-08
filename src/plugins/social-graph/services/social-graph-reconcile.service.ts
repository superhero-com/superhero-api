import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { SocialGraphEdge } from '../entities/social-graph-edge.entity';
import { SocialGraphContractService } from '../social-graph-contract.service';
import { SocialGraphService } from '../social-graph.service';

// Bound how many recently-active addresses one reconcile pass checks against the
// chain, so a burst of activity can never fan out into an unbounded node load.
const MAX_ADDRESSES_PER_RUN = 100;

/**
 * Drift guard for the index. The chain is the source of truth and the index can
 * drift (a missed event, a reorg edge case); the contract keeps its own
 * following/followers counters, so there is an authoritative number to check
 * against. This job is bounded — it only re-checks addresses with edge activity
 * since the last run, never sweeps the whole graph — and its remit is detect and
 * alarm only: the chain exposes counts and pair-wise reads, not enumeration, so
 * there is nothing to rebuild an address from.
 */
@Injectable()
export class SocialGraphReconcileService implements OnModuleInit {
  private readonly logger = new Logger(SocialGraphReconcileService.name);
  private lastCheckedId = 0;

  constructor(
    @InjectRepository(SocialGraphEdge)
    private readonly edgeRepo: Repository<SocialGraphEdge>,
    private readonly contractService: SocialGraphContractService,
    private readonly socialGraphService: SocialGraphService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Start from the current tip so the first pass only checks activity that
    // happens after boot, never a full-graph sweep of pre-existing edges.
    const latest = await this.edgeRepo
      .createQueryBuilder('edge')
      .select('MAX(edge.id)', 'max')
      .getRawOne<{ max: number | null }>();
    this.lastCheckedId = Number(latest?.max ?? 0);
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcile(): Promise<void> {
    if (!this.contractService.isConfigured()) {
      return;
    }
    try {
      const addresses = await this.recentlyActiveAddresses();
      if (addresses.length === 0) {
        return;
      }
      for (const address of addresses) {
        await this.hasDrift(address);
      }
    } catch (error) {
      // A throw from a Cron handler is unhandled; log and swallow.
      this.logger.error(
        'social-graph reconcile failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async manualReconcile(): Promise<void> {
    await this.reconcile();
  }

  private async recentlyActiveAddresses(): Promise<string[]> {
    const rows = await this.edgeRepo
      .createQueryBuilder('edge')
      .select('edge.id', 'id')
      .addSelect('edge.from_address', 'from_address')
      .addSelect('edge.to_address', 'to_address')
      .where('edge.id > :lastCheckedId', { lastCheckedId: this.lastCheckedId })
      .orderBy('edge.id', 'ASC')
      .getRawMany<{ id: number; from_address: string; to_address: string }>();

    if (rows.length === 0) {
      return [];
    }
    this.lastCheckedId = Number(rows[rows.length - 1].id);

    const addresses = new Set<string>();
    for (const row of rows) {
      addresses.add(row.from_address);
      addresses.add(row.to_address);
      if (addresses.size >= MAX_ADDRESSES_PER_RUN) {
        break;
      }
    }
    return [...addresses];
  }

  private async hasDrift(address: string): Promise<boolean> {
    const [indexedFollowers, indexedFollowing, chainFollowers, chainFollowing] =
      await Promise.all([
        this.socialGraphService.getFollowersCount(address),
        this.socialGraphService.getFollowingCount(address),
        this.contractService.getFollowersCount(address),
        this.contractService.getFollowingCount(address),
      ]);

    if (
      indexedFollowers === chainFollowers &&
      indexedFollowing === chainFollowing
    ) {
      return false;
    }

    this.logger.error(
      `social-graph index drift for ${address}: ` +
        `followers indexed=${indexedFollowers} chain=${chainFollowers}, ` +
        `following indexed=${indexedFollowing} chain=${chainFollowing}` +
        ' — no automatic repair exists; re-sync from the deploy block manually',
    );
    return true;
  }
}
