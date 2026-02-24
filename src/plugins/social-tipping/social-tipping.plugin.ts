import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { SocialTippingPluginSyncService } from './social-tipping-plugin-sync.service';
import { decode } from '@aeternity/aepp-sdk';

@Injectable()
export class SocialTippingPlugin extends BasePlugin {
  protected readonly logger = new Logger(SocialTippingPlugin.name);
  readonly name = 'social-tipping';
  readonly version = 1;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private socialTippingPluginSyncService: SocialTippingPluginSyncService,
  ) {
    super();
  }

  startFromHeight(): number {
    // Tips can happen at any height
    return 0;
  }

  filters(): PluginFilter[] {
    return [
      {
        predicate: (tx: Partial<Tx>) => {
          // Check if it's a SpendTx and has a payload
          if (tx.type !== 'SpendTx' || !tx.raw?.payload) {
            return false;
          }

          // Try to decode payload and check for tip prefixes
          try {
            const payloadData = decode(tx.raw.payload).toString();
            const supportedPayloads = ['TIP_PROFILE', 'TIP_POST'];
            return supportedPayloads.some((payload) =>
              payloadData.startsWith(payload),
            );
          } catch (error) {
            // If decoding fails, it's not a tip transaction
            return false;
          }
        },
      },
    ];
  }

  protected getSyncService(): SocialTippingPluginSyncService {
    return this.socialTippingPluginSyncService;
  }
}
