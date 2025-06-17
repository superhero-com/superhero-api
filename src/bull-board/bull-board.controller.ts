import {
  All,
  Controller,
  Inject,
  Next,
  Request,
  Response,
} from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core';
import * as express from 'express';
import { MODULE_CONFIG_TOKEN } from './bull-board.constants';
import { BullBoardModuleConfig } from './interfaces';

@Controller('bull-board')
export class BullBoardController {
  constructor(
    @Inject(MODULE_CONFIG_TOKEN)
    private readonly moduleConfig: BullBoardModuleConfig,
    private readonly app: ApplicationConfig,
  ) {}

  @All(['', '*'])
  admin(
    @Request() req: express.Request,
    @Response() res: express.Response,
    @Next() next: express.NextFunction,
  ) {
    const mountPath = `/${this.app.getGlobalPrefix()}/${
      this.moduleConfig.config.path
    }`;
    const router = this.moduleConfig.adapter.setBasePath(mountPath).getRouter();
    req.url = req.url.replace(mountPath, '') || '/';
    return router(req, res, next);
  }
}
