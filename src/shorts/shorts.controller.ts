import { shortsStorageScope } from './shorts-runtime-scope';
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
  UseGuards,
  Res,
  Req,
  Headers,
  BadRequestException,
  Header,
  HttpCode,
  HttpException,
  GoneException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ShortsService } from './shorts.service';
import { ShortsAuthService } from './shorts-auth.service';
import { ShortsAuthGuard } from './shorts-auth.guard';
import { ShortsUploadInterceptor } from './shorts-upload.interceptor';
import {
  SHORTS_UPLOAD_SIGNAL,
  ShortsUploadRequest,
} from './shorts-upload-context';
import { PlaybackEvent } from './shorts-analytics.service';
import { communityGuidelines } from './shorts-eligibility';
import { ShortsLifecycleJobsService } from './shorts-lifecycle-jobs.service';
import { ShortsRateGuard } from './shorts-rate.guard';
import { ShortsWalletTransactionsService } from './shorts-wallet-transactions.service';
import { ShortsPlaybackEvidenceService } from './shorts-playback-evidence.service';
import { ShortsMeasurementMonitorService } from './shorts-measurement-monitor.service';
import { ShortsReconciliationService } from './shorts-reconciliation.service';
import { ShortsCommentsService } from './shorts-comments.service';
import { ShortsLikeSponsorshipService } from './shorts-like-sponsorship.service';

@ApiTags('shorts')
@Controller('shorts')
@UseGuards(ShortsRateGuard)
export class ShortsController {
  constructor(
    private readonly shorts: ShortsService,
    private readonly auth: ShortsAuthService,
    private readonly uploads: ShortsUploadsService,
    @Optional() private readonly lifecycle?: ShortsLifecycleJobsService,
    @Optional()
    private readonly walletTransactions?: ShortsWalletTransactionsService,
    @Optional()
    private readonly playbackEvidence?: ShortsPlaybackEvidenceService,
    @Optional()
    private readonly measurements?: ShortsMeasurementMonitorService,
    @Optional()
    private readonly reconciliation?: ShortsReconciliationService,
    @Optional() private readonly comments?: ShortsCommentsService,
    @Optional()
    private readonly likeSponsorships?: ShortsLikeSponsorshipService,
  ) {}
  @Post('like-sponsorships')
  @Header('Cache-Control', 'no-store')
  @HttpCode(202)
  async sponsorLike(
    @Headers('authorization') authorization: string,
    @Body() body: { id: string; videoId: string; signedInnerTx: string },
  ) {
    if (!this.likeSponsorships)
      throw new ServiceUnavailableException('Like sponsorship is unavailable');
    return this.likeSponsorships.enqueue(
      await this.auth.authenticate(authorization),
      body,
    );
  }
  @Get('like-sponsorships/:innerHash')
  @Header('Cache-Control', 'no-store')
  sponsoredLikeStatus(
    @Param('innerHash') innerHash: string,
    @Query('address') address: string,
    @Query('contract') contract: string,
  ) {
    if (!this.likeSponsorships)
      throw new ServiceUnavailableException('Like sponsorship is unavailable');
    return this.likeSponsorships.observe(innerHash, address, contract);
  }
  @Get('config')
  @Header('Cache-Control', 'no-store')
  config() {
    return this.shorts.config();
  }
  @Get('comments/authors/:address')
  @Header('Cache-Control', 'no-store')
  commentAuthor(@Param('address') address: string) {
    return this.comments.author(address);
  }
  @Get(':id/comments')
  @Header('Cache-Control', 'no-store')
  commentPage(
    @Param('id') id: string,
    @Query() query: { cursor?: string; version?: string; limit?: string },
  ) {
    return this.comments.page(id, query);
  }
  @Get(':id/stats')
  @Header('Cache-Control', 'no-store')
  videoStats(@Param('id') id: string) {
    return this.comments.stats(id);
  }
  @Get('health/playback')
  @Header('Cache-Control', 'no-store')
  playbackHealth() {
    return this.shorts.playbackHealth();
  }
  @Post('auth/challenge')
  @Header('Cache-Control', 'no-store')
  challenge(@Body() body: { address: string }) {
    return this.auth.challenge(body?.address);
  }
  @Post('auth/verify')
  @Header('Cache-Control', 'no-store')
  verify(@Body() body: { id: string; signature: string }) {
    return this.auth.verify(body?.id, body?.signature);
  }
  @Post('auth/connect')
  @Header('Cache-Control', 'no-store')
  connect(@Body() body: { address: string }) {
    return this.auth.connect(body?.address);
  }
  @Post('auth/logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  logout(@Headers('authorization') authorization: string) {
    return this.auth.logout(authorization);
  }
  @Post('auth/logout-all')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  logoutAll(@Headers('authorization') authorization: string) {
    return this.auth.logoutAll(authorization);
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query('address') address = '', @Query('topic') topic = 'All') {
    return this.shorts.list(address, topic);
  }
  @Get('feed')
  @Header('Cache-Control', 'no-store')
  feed(@Query('address') address = '', @Query('cursor') cursor?: string) {
    return this.shorts.catalog(address, cursor);
  }
  @Get('feed/following')
  @Header('Cache-Control', 'no-store')
  followingFeed(
    @Query('address') address = '',
    @Query('cursor') cursor?: string,
  ) {
    return this.shorts.followingCatalog(address, cursor);
  }
  @Post('feed/following/state')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  followingState(@Body() body: { address?: string; ids?: unknown }) {
    return this.shorts.catalogState(body?.address || '', body?.ids, true);
  }
  @Post('feed/state')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  feedState(@Body() body: { address?: string; ids?: unknown }) {
    return this.shorts.catalogState(body?.address || '', body?.ids);
  }
  @Get('content')
  @Header('Cache-Control', 'no-store')
  async content(
    @Headers('authorization') authorization: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.shorts.catalog(
      await this.auth.authenticate(authorization),
      cursor,
      true,
    );
  }
  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  async dashboard(@Headers('authorization') authorization: string) {
    return this.shorts.dashboard(await this.auth.authenticate(authorization));
  }
  @Get('studio/content')
  @Header('Cache-Control', 'no-store')
  async studioContent(
    @Headers('authorization') authorization: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.shorts.studioContent(
      await this.auth.authenticate(authorization),
      query,
    );
  }
  @Get('studio/summary')
  @Header('Cache-Control', 'no-store')
  async studioSummary(
    @Headers('authorization') authorization: string,
    @Query('days') days?: string,
  ) {
    return this.shorts.studioSummary(
      await this.auth.authenticate(authorization),
      days,
    );
  }
  @Get('studio/video/:id')
  @Header('Cache-Control', 'no-store')
  async studioVideo(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Query('days') days?: string,
  ) {
    return this.shorts.studioVideo(
      await this.auth.authenticate(authorization),
      id,
      days,
    );
  }
  @Get('shared/:id') shared(
    @Param('id') id: string,
    @Query('address') address = '',
  ) {
    return this.shorts.shared(id, address);
  }
  @Get('performance')
  @Header('Cache-Control', 'no-store')
  async performance(
    @Headers('authorization') authorization: string,
    @Query('days') days = '28',
    @Query('short') shortId?: string,
  ) {
    return this.shorts.performance(
      await this.auth.authenticate(authorization),
      Number(days),
      shortId,
    );
  }
  @Post('analytics/forget')
  @Header('Cache-Control', 'no-store')
  forget(@Body() body: { session: string }) {
    return this.shorts.analytics.forget(body?.session);
  }
  @Get('review')
  @Header('Cache-Control', 'no-store')
  async review(
    @Headers('authorization') authorization: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.shorts.reviewPage(
      await this.auth.operator(authorization),
      cursor,
    );
  }
  @Get('review-media/:id') async reviewMedia(
    @Param('id') id: string,
    @Headers('authorization') authorization: string,
    @Res() res: Response,
  ) {
    const address = await this.auth.authenticate(authorization);
    const short = await this.shorts.item(id);
    if (address !== short.creator) await this.auth.operator(authorization);
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
  @Post('uploads') async startUpload(
    @Headers('authorization') authorization: string,
    @Body() body: UploadInput,
  ) {
    const actor = await this.auth.authenticate(authorization);
    return this.uploads.shared
      ? this.uploads.create(actor, body)
      : this.shorts.chain.serial(() => this.uploads.create(actor, body));
  }
  @Get('uploads/:id') async uploadStatus(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
  ) {
    return this.uploads.get(await this.auth.authenticate(authorization), id);
  }
  @Get('operator/ingestion') async ingestionHealth(
    @Headers('authorization') authorization: string,
  ) {
    await this.auth.operator(authorization);
    return this.uploads.health();
  }
  @Get('operator/lifecycle')
  @Header('Cache-Control', 'no-store')
  async lifecycleHealth(@Headers('authorization') authorization: string) {
    await this.auth.operator(authorization);
    if (!this.lifecycle)
      throw new ServiceUnavailableException(
        'Lifecycle status requires the hosted API',
      );
    return this.lifecycle.health(shortsStorageScope(this.shorts.chain));
  }
  @Get('operator/measurements')
  @Header('Cache-Control', 'no-store')
  async measurementHealth(@Headers('authorization') authorization: string) {
    await this.auth.operator(authorization);
    if (!this.measurements)
      throw new ServiceUnavailableException(
        'Measurement monitoring unavailable',
      );
    return this.measurements.snapshot();
  }
  @Get('operator/reconciliation')
  @Header('Cache-Control', 'no-store')
  async reconcileAccounting(
    @Headers('authorization') authorization: string,
    @Query('contract') contract?: string,
    @Query('height') height?: string,
    @Query('blockHash') blockHash?: string,
    @Query('after') after?: string,
  ) {
    await this.auth.operator(authorization);
    if (!this.reconciliation)
      throw new ServiceUnavailableException(
        'Accounting reconciliation requires the hosted API',
      );
    return this.reconciliation.compare({ contract, height, blockHash, after });
  }
  @Post('uploads/:id/parts/:index')
  @UseGuards(ShortsAuthGuard)
  @UseInterceptors(
    ShortsUploadInterceptor,
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 + 1, files: 1, fields: 0 },
    }),
  )
  async uploadPart(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Param('index') index: string,
    @UploadedFile() file: { buffer: Buffer },
    @Req() request: ShortsUploadRequest,
  ) {
    const actor = await this.auth.authenticate(authorization);
    return this.uploads.shared
      ? this.uploads.part(
          actor,
          id,
          Number(index),
          file?.buffer,
          request?.[SHORTS_UPLOAD_SIGNAL],
        )
      : this.shorts.chain.serial(() =>
          this.uploads.part(
            actor,
            id,
            Number(index),
            file?.buffer,
            request?.[SHORTS_UPLOAD_SIGNAL],
          ),
        );
  }
  @Post('uploads/:id/parts/:index/prepare')
  @Header('Cache-Control', 'no-store')
  async prepareDirectPart(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Param('index') index: string,
    @Body() body: { sha256: string },
  ) {
    return this.uploads.prepareDirect(
      await this.auth.authenticate(authorization),
      id,
      Number(index),
      body?.sha256,
    );
  }
  @Post('uploads/:id/parts/:index/authorize')
  @Header('Cache-Control', 'no-store')
  async authorizeDirectPart(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Param('index') index: string,
    @Body() body: { checksum: string },
  ) {
    return this.uploads.authorizeDirect(
      await this.auth.authenticate(authorization),
      id,
      Number(index),
      body?.checksum,
    );
  }
  @Post('uploads/:id/parts/:index/complete')
  @Header('Cache-Control', 'no-store')
  async completeDirectPart(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Param('index') index: string,
  ) {
    return this.uploads.completeDirect(
      await this.auth.authenticate(authorization),
      id,
      Number(index),
    );
  }
  @Post('uploads/:id/finish')
  @HttpCode(202)
  @UseGuards(ShortsAuthGuard)
  @UseInterceptors(ShortsUploadInterceptor)
  async finishUpload(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Req() request: ShortsUploadRequest,
  ) {
    const actor = await this.auth.authenticate(authorization);
    return this.uploads.finish(actor, id, request?.[SHORTS_UPLOAD_SIGNAL]);
  }
  @Post('upload')
  @HttpCode(202)
  @UseGuards(ShortsAuthGuard)
  @UseInterceptors(
    ShortsUploadInterceptor,
    FileInterceptor('file', {
      limits: {
        fileSize: 40 * 1024 * 1024,
        files: 1,
        fields: 9,
        fieldSize: 12000,
      },
    }),
  )
  async upload(
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
    @Req() request: ShortsUploadRequest,
  ) {
    const address = await this.auth.authenticate(authorization);
    if (!file || body.rights !== 'true')
      throw new BadRequestException(
        'Choose a video and confirm publishing rights',
      );
    return this.uploads.enqueueFile(
      address,
      {
        title: body.title,
        topic: body.topic,
        rights: true,
        details: {
          description: body.description || '',
          language: body.language || 'und',
          synthetic: body.synthetic === 'true',
          sponsored: body.sponsored === 'true',
          captions: body.captions || '',
        },
      },
      file.buffer,
      request?.[SHORTS_UPLOAD_SIGNAL],
    );
  }
  @Post('review/:id') async moderate(
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
    const operator = await this.auth.operator(authorization);
    if (typeof body.approved !== 'boolean')
      throw new BadRequestException('Explicit review decision required');
    const decide = () =>
      this.shorts.moderate(
        id,
        body.approved,
        body.reason || '',
        body.topic,
        body.visualConfirmed === true,
        operator,
      );
    return this.shorts.records.shared
      ? decide()
      : this.shorts.chain.serial(decide);
  }
  @Post(':id/scan') async scan(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
  ) {
    const actor = await this.auth.authenticate(authorization);
    if (actor !== (await this.shorts.item(id)).creator)
      await this.auth.operator(authorization);
    return this.shorts.chain.serial(async () => {
      const safety = await this.shorts.rescan(id);
      return actor === this.shorts.chain.operator.address &&
        !this.shorts.demoAutoApprove
        ? safety
        : communityGuidelines(
            await this.shorts.item(id),
            this.shorts.demoAutoApprove,
          );
    });
  }
  @Post(':id/appeal') async appeal(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Body() body: { message: string },
  ) {
    const actor = await this.auth.authenticate(authorization);
    const appeal = () => this.shorts.appeal(actor, id, body.message);
    return this.shorts.records.shared
      ? appeal()
      : this.shorts.chain.serial(appeal);
  }
  @Post(':id/playback') async playback(
    @Param('id') id: string,
    @Body() body: PlaybackEvent & { proof?: unknown },
  ) {
    try {
      const short = await this.shorts.ensurePlayable(id);
      if (!this.playbackEvidence)
        throw new ServiceUnavailableException(
          'Playback measurement unavailable',
        );
      const { startedAt, ...event } = this.playbackEvidence.validate(
        short,
        body,
      );
      // The signed clock anchors the first qualified update, without a zero row.
      if (event.seconds < 2) {
        const counters = await this.shorts.analytics.counters(id);
        this.measurements?.record('ignored_below_threshold');
        return { accepted: true, ...counters };
      }
      const result = await this.shorts.analytics.record(
        short,
        event,
        startedAt,
      );
      this.measurements?.record(
        result.accepted ? 'accepted_update' : 'rejected_duplicate_or_forgotten',
      );
      return result;
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      this.measurements?.failure(status);
      throw error;
    }
  }
  @Get(':id/publication')
  @Header('Cache-Control', 'no-store')
  async publication(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
  ) {
    return this.shorts.publication(
      await this.auth.authenticate(authorization),
      id,
    );
  }
  @Post(':id/publish')
  @Header('Cache-Control', 'no-store')
  async publish(
    @Headers('authorization') authorization: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.auth.authenticate(authorization);
    const result = this.shorts.records.shared
      ? await this.shorts.publish(actor, id)
      : await this.shorts.chain.serial(() => this.shorts.publish(actor, id));
    response?.status(result.publicationPending ? 202 : 200);
    return result;
  }
  @Post('receipt') async receipt(
    @Headers('authorization') authorization: string,
    @Body() body: { tx: string },
  ) {
    const address = await this.auth.authenticate(authorization);
    return this.shorts.chain.recordTransaction(address, body?.tx);
  }
  @Get('wallet-transactions/:tx')
  @Header('Cache-Control', 'no-store')
  walletTransaction(
    @Param('tx') tx: string,
    @Query('address') address: string,
    @Query('contract') contract: string,
  ) {
    if (!this.walletTransactions)
      throw new ServiceUnavailableException(
        'Wallet transaction checks are unavailable',
      );
    return this.walletTransactions.observe(tx, address, contract);
  }
  @Post(':id/view') view(
    @Param('id') id: string,
    @Body() body: { session: string },
  ) {
    const view = () => this.shorts.view(id, body.session);
    return this.shorts.records.shared ? view() : this.shorts.chain.serial(view);
  }
  @Post(':id/report') report(
    @Param('id') id: string,
    @Body() body: { id: string; reason: string; detail?: string },
  ) {
    const report = () => this.shorts.report(id, body);
    return this.shorts.records.shared
      ? report()
      : this.shorts.chain.serial(report);
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
