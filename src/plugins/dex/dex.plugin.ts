import { TX_FUNCTIONS } from '@/configs';
import { BasePlugin } from '@/mdw-sync/plugins/base-plugin';
import { PluginFilter } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEX_CONTRACTS } from './config/dex-contracts.config';
import { DexSyncTransactionService } from './services/dex-sync-transaction.service';

@Injectable()
export class DexPlugin extends BasePlugin {
  readonly version = 1;
  readonly name = 'dex';
  protected readonly logger = new Logger(DexPlugin.name);

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly dexSyncService: DexSyncTransactionService,
  ) {
    super();
  }

  protected getSyncService(): BasePluginSyncService {
    return this.dexSyncService;
  }

  startFromHeight(): number {
    // Start from a reasonable height where DEX contracts were deployed
    return 100000; // Adjust based on your network
  }

  filters(): PluginFilter[] {
    return [
      {
        type: 'contract_call' as const,
        contractIds: [DEX_CONTRACTS.router, DEX_CONTRACTS.factory],
        functions: [
          TX_FUNCTIONS.swap_exact_tokens_for_tokens,
          TX_FUNCTIONS.swap_tokens_for_exact_tokens,
          TX_FUNCTIONS.swap_exact_tokens_for_ae,
          TX_FUNCTIONS.swap_tokens_for_exact_ae,
          TX_FUNCTIONS.swap_exact_ae_for_tokens,
          TX_FUNCTIONS.swap_ae_for_exact_tokens,
          TX_FUNCTIONS.add_liquidity,
          TX_FUNCTIONS.remove_liquidity,
          TX_FUNCTIONS.add_liquidity_ae,
          TX_FUNCTIONS.remove_liquidity_ae,
        ],
      },
    ];
  }
}
