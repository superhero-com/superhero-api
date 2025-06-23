import { createBullBoard } from '@bull-board/api';
import { ExpressAdapter } from '@bull-board/express';
import { BullModule } from '@nestjs/bull';
import { BullMetadataAccessor } from '@nestjs/bull/dist/bull-metadata.accessor';
import { Module } from '@nestjs/common';
import { ApplicationConfig, DiscoveryModule } from '@nestjs/core';
import {
  defaultBullBoardConfig,
  MODULE_CONFIG_TOKEN,
} from './bull-board.constants';
import { BullBoardController } from './bull-board.controller';
import { BullBoardService } from './bull-board.service';
import { BullBoard } from './interfaces';
@Module({
  controllers: [BullBoardController],
  providers: [
    {
      provide: MODULE_CONFIG_TOKEN,
      useFactory: (app: ApplicationConfig) => {
        const serverAdapter = new ExpressAdapter();
        serverAdapter.setBasePath(
          `/${app.getGlobalPrefix()}/${defaultBullBoardConfig.path}`,
        );

        const bullBoard: BullBoard = createBullBoard({
          queues: [],
          serverAdapter,
        });

        return {
          config: defaultBullBoardConfig,
          adapter: serverAdapter,
          board: bullBoard,
        };
      },
      inject: [ApplicationConfig],
    },
    BullBoardService,
    BullMetadataAccessor,
  ],
  imports: [BullModule, DiscoveryModule],
})
export class BullBoardModule {
  //
}
