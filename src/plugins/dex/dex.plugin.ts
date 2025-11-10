import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { DexPluginSyncService } from './dex-plugin-sync.service';
import { DEX_CONTRACTS } from '@/dex/config/dex-contracts.config';
import { TX_FUNCTIONS } from '@/configs/constants';

@Injectable()
export class DexPlugin extends BasePlugin {
  protected readonly logger = new Logger(DexPlugin.name);
  readonly name = 'dex';
  readonly version = 1;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private dexPluginSyncService: DexPluginSyncService,
  ) {
    super();
  }

  startFromHeight(): number {
    // Start from block 0 - DEX contracts may have been deployed at different heights
    // The plugin will filter transactions by contract address and function
    return 0;
  }

  filters(): PluginFilter[] {
    const routerAddress = DEX_CONTRACTS.router;

    if (!routerAddress) {
      this.logger.warn('[DEX] No router contract address configured');
      return [];
    }

    const contractIds = [routerAddress];
    const functions = [
      TX_FUNCTIONS.swap_exact_tokens_for_tokens,
      TX_FUNCTIONS.swap_tokens_for_exact_tokens,
      TX_FUNCTIONS.swap_exact_ae_for_tokens,
      TX_FUNCTIONS.swap_exact_tokens_for_ae,
      TX_FUNCTIONS.swap_ae_for_exact_tokens,
      TX_FUNCTIONS.swap_tokens_for_exact_ae,
      TX_FUNCTIONS.add_liquidity,
      TX_FUNCTIONS.add_liquidity_ae,
      TX_FUNCTIONS.remove_liquidity,
      TX_FUNCTIONS.remove_liquidity_ae,
    ];

    return [
      {
        predicate: (tx: Partial<Tx>) => {
          return (
            tx.type === 'ContractCallTx' &&
            !!tx.contract_id &&
            contractIds.includes(tx.contract_id) &&
            !!tx.function &&
            functions.includes(tx.function as any)
          );
        },
      },
    ];
  }

  protected getSyncService(): DexPluginSyncService {
    return this.dexPluginSyncService;
  }
}



