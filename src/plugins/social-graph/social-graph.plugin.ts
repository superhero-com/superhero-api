import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { SocialGraphService } from './social-graph.service';
import { SocialGraphWorkerService } from './social-graph-worker.service';
import { SocialGraphGateway } from './social-graph.gateway';
import { SocialGraphTransactionProcessorService } from './services/transaction-processor.service';

@Injectable()
export class SocialGraphPlugin extends BasePlugin {
  protected readonly logger = new Logger(SocialGraphPlugin.name);
  readonly name = 'social-graph';
  readonly version = 1;

  constructor(
    @InjectRepository(Tx) protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly processor: SocialGraphTransactionProcessorService,
    private readonly graph: SocialGraphService,
    private readonly worker: SocialGraphWorkerService,
    private readonly db: DataSource,
    private readonly gateway: SocialGraphGateway,
  ) {
    super();
  }

  startFromHeight(): number {
    return 0;
  }

  filters(): PluginFilter[] {
    if (!this.graph.isConfigured()) return [];
    const contract = this.graph.getReader().identity.contract;
    return [
      {
        type: 'contract_call',
        contractIds: [contract],
        predicate: (tx) =>
          tx.contract_id === contract ||
          (Array.isArray(tx.raw?.log) &&
            tx.raw.log.some((log) => log.address === contract)),
      },
    ];
  }

  protected getSyncService() {
    return this.processor;
  }

  async onReorg(removedTxHashes: string[]): Promise<void> {
    if (!this.graph.isConfigured() || !removedTxHashes.length) return;
    const { network, contract } = this.graph.getReader().identity;
    for (let offset = 0; offset < removedTxHashes.length; offset += 1000) {
      // Lost deletions cannot be undone from live edges. Invalidate only the
      // affected namespace, then rebuild/replay from a verified snapshot.
      const rows = await this.db.query(
        `WITH invalidated AS (UPDATE social_graph_projection_scopes s SET state='rebuilding'
        WHERE network=$1 AND contract=$2 AND generation=(SELECT MAX(generation) FROM social_graph_projection_scopes WHERE network=$1 AND contract=$2)
        AND EXISTS(SELECT 1 FROM social_graph_projection_events e WHERE e.network=s.network AND e.contract=s.contract AND e.generation=s.generation AND e.tx_hash=ANY($3::text[]))
        RETURNING generation) SELECT generation::text FROM invalidated`,
        [network, contract, removedTxHashes.slice(offset, offset + 1000)],
      );
      if (rows.length)
        await this.gateway.changed({
          network,
          contract,
          generation: rows[0].generation,
        });
    }
    this.worker.requestSync();
  }
}
