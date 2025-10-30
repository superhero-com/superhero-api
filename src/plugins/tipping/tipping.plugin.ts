import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePlugin } from '@/mdw-sync/plugins/base-plugin';
import { PluginFilter, Tx } from '@/mdw-sync/plugins/plugin.interface';
import { BasePluginSyncService } from '@/mdw-sync/plugins/base-plugin-sync.service';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { decode } from '@aeternity/aepp-sdk';
import { TippingSyncTransactionService } from './services/tipping-sync-transaction.service';

@Injectable()
export class TippingPlugin extends BasePlugin {
  readonly version = 1;
  readonly name = 'tipping';
  protected readonly logger = new Logger(TippingPlugin.name);

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly tippingSyncService: TippingSyncTransactionService,
  ) {
    super();
  }

  protected getSyncService(): BasePluginSyncService {
    return this.tippingSyncService;
  }

  startFromHeight(): number {
    // Start from a reasonable height where tipping was implemented
    return 100000; // Adjust based on your network
  }

  filters(): PluginFilter[] {
    return [
      {
        type: 'spend' as const,
        predicate: (tx: Partial<Tx>) => {
          if (tx.raw?.tx?.type !== 'SpendTx') {
            return false;
          }

          const payload = tx.raw.tx.payload;
          if (!payload) {
            return false;
          }

          try {
            const payloadData = decode(tx.raw.tx.payload).toString();
            const supportedPayloads = ['TIP_PROFILE', 'TIP_POST'];
            return supportedPayloads.some((payload) =>
              payloadData.startsWith(payload),
            );
          } catch (error: any) {
            return false;
          }
        },
      },
    ];
  }
}
