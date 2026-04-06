import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Account } from '@/account/entities/account.entity';
import { AeModule } from '@/ae/ae.module';
import { AddressLinksPlugin } from './address-links.plugin';
import { AddressLinksPluginSyncService } from './address-links-plugin-sync.service';

@Module({
  imports: [TypeOrmModule.forFeature([Tx, PluginSyncState, Account]), AeModule],
  providers: [AddressLinksPluginSyncService, AddressLinksPlugin],
  exports: [AddressLinksPlugin],
})
export class AddressLinksPluginModule {}
