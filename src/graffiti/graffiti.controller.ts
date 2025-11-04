import {
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { GraffitiIpfsService } from '@/graffiti/services/graffiti.ipfs.service';
import { GraffitiStorageService } from '@/graffiti/services/graffiti.storage.service';
import { GraffitiBlockchainService } from '@/graffiti/services/graffiti.blockchain.service';
import * as fs from 'fs';
import * as path from 'path';

@Controller()
export class GraffitiController {
  constructor(
    private readonly ipfs: GraffitiIpfsService,
    private readonly storage: GraffitiStorageService,
    private readonly blockchain: GraffitiBlockchainService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('image'))
  async upload(@UploadedFile() file?: any) {
    if (!file) throw new BadRequestException('File needs to be provided.');
    if (file.mimetype !== 'image/svg+xml')
      throw new BadRequestException('File needs to be image/svg+xml.');
    // Minimal sanity: require width/height in mm in root <svg> like original
    const svgString = file.buffer.toString('utf8');
    if (
      !/\swidth\s*=\s*"[\d.]+mm"/i.test(svgString) ||
      !/\sheight\s*=\s*"[\d.]+mm"/i.test(svgString)
    ) {
      throw new BadRequestException('Height/Width not recognized');
    }
    const result = await this.ipfs.addAndPin(file.buffer);
    await this.storage.backupSvg(result.path, file.buffer);
    return { hash: result.path };
  }

  @Get('ipfs/:hash.svg')
  async getIpfs(@Param('hash') hash: string, @Res() res: Response) {
    if (!hash) throw new BadRequestException();
    // 1) local, 2) s3, 3) ipfs
    const local = await this.storage.tryReadLocal(hash).catch(() => null);
    if (local) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Length', Buffer.byteLength(local));
      return res.end(local);
    }
    const s3 = await this.storage.retrieveSvg(hash).catch(() => null);
    if (s3) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Length', s3.length);
      return res.end(s3);
    }
    const fromIpfs = await this.ipfs.getFile(hash).catch(() => null);
    if (fromIpfs) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Length', fromIpfs.length);
      return res.end(fromIpfs);
    }
    return res.sendStatus(404);
  }

  @Get('rendered/latest.svg')
  async getLatestSvg(@Res() res: Response) {
    const p = path.join(
      process.cwd(),
      'data',
      'graffiti-rendered',
      'latest.svg',
    );
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="black"/></svg>';
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(svg);
  }

  @Get('rendered/latest_small.png')
  async getLatestSmallPng(@Res() res: Response) {
    const p = path.join(
      process.cwd(),
      'data',
      'graffiti-rendered',
      'latest_small.png',
    );
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }
    // tiny 1x1 transparent PNG
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/Ut2Cz8AAAAASUVORK5CYII=';
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  }

  @Get('bid/:id')
  async getBid(@Param('id') id: string) {
    const searchId = Number(id);
    if (Number.isNaN(searchId)) throw new BadRequestException();
    const slots = await this.blockchain.auctionSlots();
    const currentHeight = await this.blockchain.height();
    const allBids = slots.reduce((acc: any[], slot: any) => {
      const baseSlot = Object.assign({}, slot, {
        successful_bids: null,
        failed_bids: null,
        active:
          currentHeight > slot.start_block_height &&
          currentHeight <= slot.end_block_height,
      });
      const success = slot.successful_bids.map((b: any) =>
        Object.assign(b, { slot: baseSlot, success: true }),
      );
      const failed = slot.failed_bids.map((b: any) =>
        Object.assign(b, { slot: baseSlot, success: false }),
      );
      return acc.concat(success).concat(failed);
    }, [] as any[]);
    const bid = allBids.find((b: any) => Number(b.seq_id) === searchId);
    if (!bid) return { statusCode: 404 };
    return bid;
  }
}
