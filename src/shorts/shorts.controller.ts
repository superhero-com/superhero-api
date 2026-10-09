import { ShortsUploadsService, UploadInput } from './shorts-uploads.service';
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
  Res,
  Headers,
  BadRequestException,
  Header,
  GoneException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ShortsService } from './shorts.service';
import { ShortsAuthService } from './shorts-auth.service';
import { PlaybackEvent } from './shorts-analytics.service';
import { communityGuidelines, creatorContent } from './shorts-eligibility';

@ApiTags('shorts')
@Controller('shorts')
export class ShortsController {
  constructor(
    private readonly shorts: ShortsService,
    private readonly auth: ShortsAuthService,
    private readonly uploads: ShortsUploadsService,
  ) {}
  @Get('config') config() {
    return this.shorts.config();
  }
  @Post('auth/challenge') challenge(@Body() body: { address: string }) {
    return this.auth.challenge(body.address);
  }
  @Post('auth/verify') verify(@Body() body: { id: string; signature: string }) {
    return this.auth.verify(body.id, body.signature);
  }
  @Post('auth/connect') connect(@Body() body: { address: string }) {
    return this.auth.connect(body.address);
  }
  @Get() list(@Query('address') address = '', @Query('topic') topic = 'All') {
    return this.shorts.list(address, topic);
  }
  @Get('dashboard') dashboard(@Headers('authorization') authorization: string) {
    return this.shorts.dashboard(this.auth.authenticate(authorization));
  }
  @Get('shared/:id') shared(
    @Param('id') id: string,
    @Query('address') address = '',
  ) {
    return this.shorts.shared(id, address);
  }
  @Get('performance') performance(
    @Headers('authorization') authorization: string,
    @Query('days') days = '28',
    @Query('short') shortId?: string,
  ) {
    return this.shorts.performance(
      this.auth.authenticate(authorization),
      Number(days),
      shortId,
    );
  }
  @Post('analytics/forget') forget(@Body() body: { session: string }) {
    return this.shorts.analytics.forget(body.session);
  }
  @Get('review') review(@Headers('authorization') authorization: string) {
    this.auth.operator(authorization);
    return this.shorts.chain.state.shorts.map((s) => ({
      id: s.id,
      title: s.title,
      moderation: s.moderation,
      topic: s.topic,
      reports: s.reports,
      reportDetails: s.reportDetails || [],
      classification: s.classification,
      safety: s.safety,
      reviewReason: s.reviewReason,
      reviewedTopic: s.reviewedTopic,
      reviewHistory: s.reviewHistory,
      description: s.description,
      language: s.language,
      synthetic: s.synthetic,
      sponsored: s.sponsored,
      appeal: s.appeal,
      previewUrl: `/api/shorts/review-media/${s.id}`,
    }));
  }
  @Get('review-media/:id') async reviewMedia(
    @Param('id') id: string,
    @Headers('authorization') authorization: string,
    @Res() res: Response,
  ) {
    const address = this.auth.authenticate(authorization);
    const short = this.shorts.item(id);
    if (address !== short.creator) this.auth.operator(authorization);
    const data = await this.shorts.media.preview(short);
    return res
      .set({
        'Content-Type': 'video/mp4',
        'Content-Length': String(data.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(data);
  }
  @Post('uploads') startUpload(
    @Headers('authorization') authorization: string,
    @Body() body: UploadInput,
  ) {
    const actor = this.auth.authenticate(authorization);
    return this.shorts.chain.serial(() => this.uploads.create(actor, body));
  }
  @Get('uploads/:id') uploadStatus(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
  ) {
    return this.uploads.get(this.auth.authenticate(authorization), id);
  }
  @Post('uploads/:id/parts/:index')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 + 1, files: 1, fields: 0 },
    }),
  )
  uploadPart(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Param('index') index: string,
    @UploadedFile() file: { buffer: Buffer },
  ) {
    const actor = this.auth.authenticate(authorization);
    return this.shorts.chain.serial(() =>
      this.uploads.part(actor, id, Number(index), file?.buffer),
    );
  }
  @Post('uploads/:id/finish') finishUpload(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
  ) {
    const actor = this.auth.authenticate(authorization);
    return this.shorts.chain.serial(async () =>
      creatorContent(
        await this.uploads.finish(actor, id),
        this.shorts.demoAutoApprove,
      ),
    );
  }
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 40 * 1024 * 1024,
        files: 1,
        fields: 9,
        fieldSize: 12000,
      },
    }),
  )
  upload(
    @Headers('authorization') authorization: string,
    @Body()
    body: {
      title: string;
      topic: string;
      rights: string;
      description?: string;
      language?: string;
      synthetic?: string;
      sponsored?: string;
      captions?: string;
    },
    @UploadedFile() file: { buffer: Buffer },
  ) {
    const address = this.auth.authenticate(authorization);
    if (!file || body.rights !== 'true')
      throw new BadRequestException(
        'Choose a video and confirm publishing rights',
      );
    return this.shorts.chain.serial(async () =>
      creatorContent(
        await this.shorts.upload(address, body.title, body.topic, file.buffer, {
          description: body.description || '',
          language: body.language || 'und',
          synthetic: body.synthetic === 'true',
          sponsored: body.sponsored === 'true',
          captions: body.captions || '',
        }),
        this.shorts.demoAutoApprove,
      ),
    );
  }
  @Post('review/:id') moderate(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Body()
    body: {
      approved: boolean;
      reason?: string;
      topic?: string;
      visualConfirmed?: boolean;
    },
  ) {
    this.auth.operator(authorization);
    if (typeof body.approved !== 'boolean')
      throw new BadRequestException('Explicit review decision required');
    return this.shorts.chain.serial(() =>
      this.shorts.moderate(
        id,
        body.approved,
        body.reason || '',
        body.topic,
        body.visualConfirmed === true,
      ),
    );
  }
  @Post(':id/scan') scan(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
  ) {
    const actor = this.auth.authenticate(authorization);
    if (actor !== this.shorts.item(id).creator)
      this.auth.operator(authorization);
    return this.shorts.chain.serial(async () => {
      const safety = await this.shorts.rescan(id);
      return actor === this.shorts.chain.operator.address &&
        !this.shorts.demoAutoApprove
        ? safety
        : communityGuidelines(
            this.shorts.item(id),
            this.shorts.demoAutoApprove,
          );
    });
  }
  @Post(':id/appeal') appeal(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Body() body: { message: string },
  ) {
    const actor = this.auth.authenticate(authorization);
    return this.shorts.chain.serial(() =>
      this.shorts.appeal(actor, id, body.message),
    );
  }
  @Post(':id/playback') async playback(
    @Param('id') id: string,
    @Body() body: PlaybackEvent,
  ) {
    const short = await this.shorts.ensurePlayable(id);
    return this.shorts.analytics.record(short, body);
  }
  @Post(':id/publish') publish(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
  ) {
    const actor = this.auth.authenticate(authorization);
    return this.shorts.chain.serial(() => this.shorts.publish(actor, id));
  }
  @Post('receipt') receipt(
    @Headers('authorization') authorization: string,
    @Body() body: { tx: string },
  ) {
    const address = this.auth.authenticate(authorization);
    return this.shorts.chain.serial(() =>
      this.shorts.chain.recordTransaction(address, body.tx),
    );
  }
  @Post(':id/view') view(
    @Param('id') id: string,
    @Body() body: { session: string },
  ) {
    return this.shorts.chain.serial(() => this.shorts.view(id, body.session));
  }
  @Post(':id/report') report(
    @Param('id') id: string,
    @Body() body: { id: string; reason: string; detail?: string },
  ) {
    return this.shorts.chain.serial(() => this.shorts.report(id, body));
  }
  @Get('playback/:id')
  @Header('Cache-Control', 'no-store')
  playbackDescriptor(@Param('id') id: string) {
    return this.shorts.playbackDescriptor(id);
  }
  @Get('media/:id/:file')
  @Header('Cache-Control', 'no-store')
  media() {
    throw new GoneException('Use the video streaming service for playback');
  }
}
