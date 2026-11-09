import { createBullBoard } from '@bull-board/api';
import { ExpressAdapter } from '@bull-board/express';
import { BullModule } from '@nestjs/bull';
import { BullMetadataAccessor } from '@nestjs/bull/dist/bull-metadata.accessor';
import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ApplicationConfig, DiscoveryModule } from '@nestjs/core';
import {
  defaultBullBoardConfig,
  MODULE_CONFIG_TOKEN,
} from './bull-board.constants';
import { BullBoardController } from './bull-board.controller';
import { BullBoardService } from './bull-board.service';
import {
  BullBoardSettings,
  resolveBullBoardSettings,
} from './bull-board.settings';
import { BullBoard, BullBoardModuleConfig } from './interfaces';

@Module({})
export class BullBoardModule {
  static forRoot(
    settings: BullBoardSettings = resolveBullBoardSettings(),
  ): DynamicModule {
    if (!settings.enabled) {
      if (settings.error) {
        new Logger(BullBoardModule.name).error(settings.error);
      }
      return { module: BullBoardModule };
    }

    return {
      module: BullBoardModule,
      controllers: [BullBoardController],
      providers: [
        {
          provide: MODULE_CONFIG_TOKEN,
          useFactory: (app: ApplicationConfig): BullBoardModuleConfig => {
            const serverAdapter = new ExpressAdapter();
            serverAdapter.setBasePath(
              `/${app.getGlobalPrefix()}/${defaultBullBoardConfig.path}`,
            );

            const bullBoard: BullBoard = createBullBoard({
              queues: [],
              serverAdapter,
            });

            return {
              config: {
                ...defaultBullBoardConfig,
                queueOptions: { readOnlyMode: settings.readOnly !== false },
                credentials: settings.credentials,
              },
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
    };
  }
}
