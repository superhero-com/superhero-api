import {
  Controller,
  Get,
  Param,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ProfileMediaAssets } from './profile-media-assets.service';
import { ProfileMediaDatabase } from './profile-media-database.service';
import { ProfileMediaGate } from './profile-media.controller';

@Controller('profile-images')
export class ProfileMediaEdgeController {
  private reads = 0;
  constructor(
    private readonly assets: ProfileMediaAssets,
    private readonly db: ProfileMediaDatabase,
  ) {}
  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { ready: true };
  }
  @Get('images/:cid/:file')
  @UseGuards(ProfileMediaGate)
  async image(
    @Param('cid') cid: string,
    @Param('file') file: string,
    @Res() response: Response,
  ) {
    if (this.reads >= 4)
      throw new ServiceUnavailableException(
        'Image delivery is busy. Try again shortly.',
      );
    this.reads += 1;
    try {
      const image = await this.assets.image(cid, file);
      response
        .set({
          'Content-Type': 'image/webp',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=60, must-revalidate',
          ETag: `"${image.etag}"`,
        })
        .send(image.data);
    } finally {
      this.reads -= 1;
    }
  }
}
