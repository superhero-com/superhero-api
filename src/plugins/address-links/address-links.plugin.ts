import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { AddressLinksPluginSyncService } from './address-links-plugin-sync.service';
import { ADDRESS_LINK_CONTRACT_ADDRESS } from './address-links.constants';

@Injectable()
export class AddressLinksPlugin extends BasePlugin {
  protected readonly logger = new Logger(AddressLinksPlugin.name);
  readonly name = 'address-links';
  readonly version = 1;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private readonly syncService: AddressLinksPluginSyncService,
  ) {
    super();
  }

  startFromHeight(): number {
    return 1273691;
  }

  filters(): PluginFilter[] {
    if (!ADDRESS_LINK_CONTRACT_ADDRESS) {
      this.logger.warn(
        '[AddressLinks] No contract address configured, plugin disabled',
      );
      return [];
    }

    return [
      {
        type: 'contract_call',
        contractIds: [ADDRESS_LINK_CONTRACT_ADDRESS],
        functions: ['link', 'unlink'],
        predicate: (tx: Partial<Tx>) =>
          tx.type === 'ContractCallTx' &&
          tx.contract_id === ADDRESS_LINK_CONTRACT_ADDRESS &&
          (tx.function === 'link' || tx.function === 'unlink'),
      },
    ];
  }

  protected getSyncService(): AddressLinksPluginSyncService {
    return this.syncService;
  }
}
