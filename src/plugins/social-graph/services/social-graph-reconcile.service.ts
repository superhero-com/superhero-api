import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { SocialGraphEdge } from '../entities/social-graph-edge.entity';
import { SocialGraphCount } from '../entities/social-graph-count.entity';
import { SocialGraphContractService } from '../social-graph-contract.service';
import { SocialGraphService } from '../social-graph.service';
import { recomputeSocialGraphCounts } from '../social-graph-counts';

// Bound how many recently-active addresses one reconcile pass checks against the
// chain, so a burst of activity can never fan out into an unbounded node load.
const MAX_ADDRESSES_PER_RUN = 100;

/**
 * Drift guard for the index. The chain is the source of truth and the index can
 * drift (a missed event, a reorg edge case); the contract keeps its own
 * following/followers counters, so there is an authoritative number to check
 * against. This job is bounded — it only re-checks addresses with edge activity
 * since the last run, never sweeps the whole graph. Chain drift is detect and
 * alarm only: the chain exposes counts and pair-wise reads, not enumeration, so
 * there is nothing to rebuild an address from. The derived counter table, being
 * a pure function of the edge table, is repaired in place per address.
 */
@Injectable()
export class SocialGraphReconcileService implements OnModuleInit {
  private readonly logger = new Logger(SocialGraphReconcileService.name);
  private lastCheckedId = 0;
  private driftAlarmed = false;

  constructor(
    @InjectRepository(SocialGraphEdge)
    private readonly edgeRepo: Repository<SocialGraphEdge>,
    @InjectRepository(SocialGraphCount)
    private readonly countRepo: Repository<SocialGraphCount>,
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
      let drifted = 0;
      for (const address of addresses) {
        // The derived counter is repaired in place — it is a pure function of
        // the edge table, so a mismatch here is never chain drift.
        await this.repairCounterDrift(address);
        if (await this.hasDrift(address)) {
          drifted += 1;
        }
      }
      if (drifted > 0) {
        await this.reportUnrepairedDrift();
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

  /**
   * Compare the maintained `social_graph_counts` row against the edge table for
   * one address and, on mismatch, recompute it. This never requests a re-sync —
   * the counter is derived from the edge table, so a divergence means the counter
   * missed a mutation, not that the edge table disagrees with the chain.
   */
  private async repairCounterDrift(address: string): Promise<void> {
    const [stored, edgeFollowers, edgeFollowing] = await Promise.all([
      this.countRepo.findOne({ where: { address } }),
      this.socialGraphService.getFollowersCount(address),
      this.socialGraphService.getFollowingCount(address),
    ]);

    const storedFollowers = stored?.followers_count ?? 0;
    const storedFollowing = stored?.following_count ?? 0;
    if (
      storedFollowers === edgeFollowers &&
      storedFollowing === edgeFollowing
    ) {
      return;
    }

    this.logger.warn(
      `social-graph counter drift for ${address}: ` +
        `followers stored=${storedFollowers} edges=${edgeFollowers}, ` +
        `following stored=${storedFollowing} edges=${edgeFollowing} — recomputing`,
    );
    await recomputeSocialGraphCounts(this.edgeRepo.manager, address);
  }

  /**
   * Once per process, so persistent drift does not spam. This used to reset
   * `backward_synced_height`, which read as a repair but was a no-op.
   */
  private async reportUnrepairedDrift(): Promise<void> {
    if (this.driftAlarmed) {
      return;
    }
    this.driftAlarmed = true;
    this.logger.error(
      'social-graph drift detected — NO automatic repair exists; ' +
        'a re-sync from the deploy block must be run manually',
    );
  }
}
