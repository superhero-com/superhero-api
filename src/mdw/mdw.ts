import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from './entities/tx.entity';
import { TxSyncService } from './services/tx-sync.service';

@Module({
  imports: [TypeOrmModule.forFeature([Tx])],
  providers: [TxSyncService],
  exports: [],
  controllers: [],
})
export class MdwModule {
  //
}
