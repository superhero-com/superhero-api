import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraffitiController } from './graffiti.controller';
import { GraffitiIpfsService } from './services/graffiti.ipfs.service';
import { GraffitiStorageService } from './services/graffiti.storage.service';
import { GraffitiBlockchainService } from './services/graffiti.blockchain.service';

@Module({
  imports: [ConfigModule],
  controllers: [GraffitiController],
  providers: [
    GraffitiIpfsService,
    GraffitiStorageService,
    GraffitiBlockchainService,
  ],
})
export class GraffitiModule {}
