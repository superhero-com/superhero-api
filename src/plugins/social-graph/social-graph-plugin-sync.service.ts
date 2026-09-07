import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Encoded } from '@aeternity/aepp-sdk';
import { In, Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import {
  SocialGraphEdge,
  SocialGraphEdgeKind,
} from './entities/social-graph-edge.entity';
import { recomputeSocialGraphCounts } from './social-graph-counts';
import { loadSocialContractAci } from './social-graph-aci';
import {
  SOCIAL_GRAPH_CONTRACT_ADDRESS,
  SOCIAL_GRAPH_PLUGIN_NAME,
} from './social-graph.constants';

interface DecodedEvent {
  name: string;
  args: string[];
}

/**
 * Indexes the SocialContract graph from its emitted events. Events are decoded
 * with the deployed-build ACI and applied as idempotent edge mutations:
 *
 *   Followed(a, b)   -> INSERT (a -> b, follow)   [ON CONFLICT DO NOTHING]
 *   Unfollowed(a, b) -> DELETE (a -> b, follow)
 *   Blocked(a, b)    -> INSERT (a -> b, block)
 *   Unblocked(a, b)  -> DELETE (a -> b, block)
 *
 * Indexing from events (not call args) is deliberate: events are emitted only
 * on success, so reverted calls apply nothing; and `block()` also emits the
 * Unfollowed events for the reciprocal follows it clears, so the cascade is
 * captured without special-casing. Order within a tx is irrelevant — each
 * mutation is independent and idempotent.
 */
@Injectable()
export class SocialGraphPluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(SocialGraphPluginSyncService.name);

  constructor(
    aeSdkService: AeSdkService,
    @InjectRepository(SocialGraphEdge)
    private readonly edgeRepo: Repository<SocialGraphEdge>,
  ) {
    super(aeSdkService);
  }

  async decodeLogs(tx: Tx): Promise<DecodedEvent[] | null> {
    if (!tx?.raw?.log) {
      return null;
    }
    try {
      const contract = await this.getContract(
        SOCIAL_GRAPH_CONTRACT_ADDRESS as Encoded.ContractAddress,
        loadSocialContractAci(),
      );
      const decoded = contract.$decodeEvents(tx.raw.log, {
        omitUnknown: true,
      });
      // Event args are `address` per the ACI, so they decode to `ak_` strings;
      // map through String so the stored jsonb is always serialisable.
      return (decoded || []).map((event: any) => ({
        name: event.name,
        args: (event.args || []).map((arg: unknown) => String(arg)),
      }));
    } catch (error: any) {
      const isUnknownEventError =
        error?.name === 'MissingEventDefinitionError' ||
        error?.message?.includes("Can't find definition");
      if (isUnknownEventError) {
        this.logger.warn(
          `Skipping unknown event in tx ${tx.hash} (contract: ${tx.contract_id})`,
        );
      } else {
        this.logger.error(
          `Failed to decode social-graph logs for tx ${tx.hash}`,
          error.stack,
        );
      }
      return null;
    }
  }

  async processTransaction(
    tx: Tx,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _syncDirection: SyncDirection,
  ): Promise<void> {
    const events = await this.getDecodedEvents(tx);
    for (const event of events) {
      await this.applyEvent(tx, event);
    }
  }

  private async getDecodedEvents(tx: Tx): Promise<DecodedEvent[]> {
    const stored = tx.logs?.[SOCIAL_GRAPH_PLUGIN_NAME]?.data;
    if (Array.isArray(stored)) {
      return stored as DecodedEvent[];
    }
    const fresh = await this.decodeLogs(tx);
    return Array.isArray(fresh) ? fresh : [];
  }

  private async applyEvent(tx: Tx, event: DecodedEvent): Promise<void> {
    const [from, to] = event.args ?? [];
    if (!from || !to) {
      return;
    }
    switch (event.name) {
      case 'Followed':
        return this.insertEdge(from, to, 'follow', tx);
      case 'Unfollowed':
        return this.deleteEdge(from, to, 'follow');
      case 'Blocked':
        return this.insertEdge(from, to, 'block', tx);
      case 'Unblocked':
        return this.deleteEdge(from, to, 'block');
      default:
        return;
    }
  }

  // Each mutation and the recompute of its two affected addresses share one
  // transaction, so a crash between them can never leave a stale counter. The
  // counters are recomputed from the edge table, never incremented, so an
  // `.orIgnore()`d re-insert or an unconditional delete stays correct.
  private async insertEdge(
    from: string,
    to: string,
    kind: SocialGraphEdgeKind,
    tx: Tx,
  ): Promise<void> {
    await this.edgeRepo.manager.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .insert()
        .into(SocialGraphEdge)
        .values({
          from_address: from,
          to_address: to,
          kind,
          height: tx.block_height,
          tx_hash: tx.hash,
        })
        .orIgnore() // ON CONFLICT (from,to,kind) DO NOTHING — safe to re-apply
        .execute();
      await recomputeSocialGraphCounts(manager, from);
      await recomputeSocialGraphCounts(manager, to);
    });
    this.logger.log(`${kind}: ${from} -> ${to}`);
  }

  private async deleteEdge(
    from: string,
    to: string,
    kind: SocialGraphEdgeKind,
  ): Promise<void> {
    await this.edgeRepo.manager.transaction(async (manager) => {
      await manager.delete(SocialGraphEdge, {
        from_address: from,
        to_address: to,
        kind,
      });
      await recomputeSocialGraphCounts(manager, from);
      await recomputeSocialGraphCounts(manager, to);
    });
    this.logger.log(`un${kind}: ${from} -> ${to}`);
  }

  /**
   * Reorg cleanup: drop edges inserted by the removed txs. This clears phantom
   * follow/block rows from orphaned blocks. A removed Unfollowed/Unblocked (an
   * edge that should be restored) is not recoverable from tx_hash alone — the
   * reconcile job's re-sync from the last validated height is the backstop.
   */
  async removeEdgesForTxs(txHashes: string[]): Promise<void> {
    if (!txHashes.length) {
      return;
    }
    await this.edgeRepo.manager.transaction(async (manager) => {
      const removed = await manager.find(SocialGraphEdge, {
        where: { tx_hash: In(txHashes) },
        select: ['from_address', 'to_address'],
      });
      const affected = new Set<string>();
      for (const edge of removed) {
        affected.add(edge.from_address);
        affected.add(edge.to_address);
      }
      await manager.delete(SocialGraphEdge, { tx_hash: In(txHashes) });
      for (const address of affected) {
        await recomputeSocialGraphCounts(manager, address);
      }
    });
  }
}
