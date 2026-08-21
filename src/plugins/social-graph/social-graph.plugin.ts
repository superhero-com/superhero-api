import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { SocialGraphPluginSyncService } from './social-graph-plugin-sync.service';
import {
  SOCIAL_GRAPH_CONTRACT_ADDRESS,
  SOCIAL_GRAPH_PLUGIN_NAME,
  SOCIAL_GRAPH_START_HEIGHT,
} from './social-graph.constants';

const SOCIAL_GRAPH_FUNCTIONS = [
  'follow',
  'unfollow',
  'block',
  'unblock',
] as const;

@Injectable()
export class SocialGraphPlugin extends BasePlugin {
  protected readonly logger = new Logger(SocialGraphPlugin.name);
  readonly name = SOCIAL_GRAPH_PLUGIN_NAME;
  readonly version = 1;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly syncService: SocialGraphPluginSyncService,
  ) {
    super();
  }

  startFromHeight(): number {
    return SOCIAL_GRAPH_START_HEIGHT;
  }

  filters(): PluginFilter[] {
    if (!SOCIAL_GRAPH_CONTRACT_ADDRESS) {
      this.logger.warn(
        '[SocialGraph] No contract address configured, plugin disabled',
      );
      return [];
    }

    return [
      {
        type: 'contract_call',
        contractIds: [SOCIAL_GRAPH_CONTRACT_ADDRESS],
        functions: [...SOCIAL_GRAPH_FUNCTIONS],
        predicate: (tx: Partial<Tx>) =>
          tx.type === 'ContractCallTx' &&
          tx.contract_id === SOCIAL_GRAPH_CONTRACT_ADDRESS &&
          SOCIAL_GRAPH_FUNCTIONS.includes(
            tx.function as (typeof SOCIAL_GRAPH_FUNCTIONS)[number],
          ),
      },
    ];
  }

  protected getSyncService(): SocialGraphPluginSyncService {
    return this.syncService;
  }

  async onReorg(removedTxHashes: string[]): Promise<void> {
    await super.onReorg(removedTxHashes);
    await this.syncService.removeEdgesForTxs(removedTxHashes);
  }
}
