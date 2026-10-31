import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Inject,
  Injectable,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { shortsClientIdentity } from '../shorts/shorts-rate.config';
import { ProfileMediaAuth } from './profile-media-auth.service';
import { PostMediaService } from './post-media.service';
import { ProfileMediaService } from './profile-media.service';
import { ProfileMediaUploads } from './profile-media-uploads.service';
import {
  IMAGE_MAX_BYTES,
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';
import {
  PostAttachmentsDto,
  ImageChallengeDto,
  ImageVerifyDto,
  ImageClaimDto,
  ImageSubmitDto,
  ImageUploadDto,
  ImagePartDto,
  ImageChecksumDto,
} from './profile-media.dto';

type ImageRequest = Request & { imageAddress: string };
@Injectable()
export class ProfileMediaGate implements CanActivate {
  private readonly client = shortsClientIdentity();
  constructor(
    private readonly auth: ProfileMediaAuth,
    @Inject(PROFILE_MEDIA_CONFIG) private readonly config: ProfileMediaConfig,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (!this.config.enabled)
      throw new ServiceUnavailableException('Profile images are unavailable');
    await this.auth.rate(
      `ip:${this.client(context.switchToHttp().getRequest<Request>())}`,
      600,
      60,
    );
    return true;
  }
}
@Injectable()
export class ProfileMediaSession implements CanActivate {
  constructor(private readonly auth: ProfileMediaAuth) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ImageRequest>();
    request.imageAddress = await this.auth.authenticate(
      request.headers.authorization,
    );
    await this.auth.rate(`session:${request.imageAddress}`, 120, 60);
    return true;
  }
}
@ApiTags('Profile images')
@Controller('profile-media')
export class ProfileMediaController {
  constructor(
    private readonly media: ProfileMediaService,
    private readonly posts: PostMediaService,
    private readonly auth: ProfileMediaAuth,
    private readonly uploads: ProfileMediaUploads,
    @Inject(PROFILE_MEDIA_CONFIG) private readonly config: ProfileMediaConfig,
  ) {}
  @Get('config')
  configRead() {
    return this.config.enabled
      ? {
          enabled: true,
          network: this.config.network,
          contract: this.config.contract,
          origin: this.config.origin,
          publicUrl: this.config.publicUrl,
          maxBytes: IMAGE_MAX_BYTES,
          transport: 'direct-s3-v1',
          formats: ['image/jpeg', 'image/png', 'image/webp'],
          posts: { maxImages: 4, maxDimension: 2048 },
          avatar: { width: 1024, height: 1024 },
          cover: { width: 1920, height: 720 },
          references: {
            prefix: 'ipfs:superhero:images:',
            previewSuffix: '-preview',
            profileLinkPrefix: 'ipfs_superhero_images_',
          },
          previews: { avatar: 128, cover: 480, post: 640, maxBytes: 49152 },
        }
      : { enabled: false };
  }
  @Post('auth/challenge')
  @UseGuards(ProfileMediaGate)
  challenge(@Body() body: ImageChallengeDto) {
    return this.auth.challenge(body.address, body.purpose);
  }
  @Post('auth/verify')
  @UseGuards(ProfileMediaGate)
  verify(@Body() body: ImageVerifyDto) {
    return this.auth.verify(body.id, body.signature);
  }
  @Post('auth/logout')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  async logout(@Req() request: ImageRequest) {
    await this.auth.logout(request.headers.authorization!);
    return { loggedOut: true };
  }
  @Post('uploads')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  async upload(@Req() request: ImageRequest, @Body() body: ImageUploadDto) {
    await this.auth.rate(
      `upload:${body.role === 'post' ? 'post:' : ''}${request.imageAddress}`,
      body.role === 'post' ? 60 : 12,
      3600,
    );
    await this.auth.rate('uploads:global', 100, 86400);
    return this.uploads.create(
      request.imageAddress,
      body.role,
      body.bytes,
      body.sha256,
    );
  }
  @Get('uploads/:id')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  uploadStatus(
    @Req() request: ImageRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.uploads.status(request.imageAddress, id);
  }
  @Post('uploads/:id/parts/:index/prepare')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  prepare(
    @Req() request: ImageRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() body: ImagePartDto,
  ) {
    return this.uploads.prepare(request.imageAddress, id, index, body.sha256);
  }
  @Post('uploads/:id/parts/:index/authorize')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  authorize(
    @Req() request: ImageRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() body: ImageChecksumDto,
  ) {
    return this.uploads.authorize(
      request.imageAddress,
      id,
      index,
      body.checksum,
    );
  }
  @Post('uploads/:id/parts/:index/complete')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  complete(
    @Req() request: ImageRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.uploads.complete(request.imageAddress, id, index);
  }
  @Post('uploads/:id/cancel')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  cancel(
    @Req() request: ImageRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.uploads.cancel(request.imageAddress, id);
  }
  @Post('uploads/:id/finish')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  finish(
    @Req() request: ImageRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.uploads.finish(request.imageAddress, id);
  }
  @Post('attachments')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  attachments(@Req() request: ImageRequest, @Body() body: PostAttachmentsDto) {
    return this.posts.retain(request.imageAddress, body.cids);
  }
  @Post('claim')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  async claim(@Req() request: ImageRequest, @Body() body: ImageClaimDto) {
    await this.auth.rate(`claim:${request.imageAddress}`, 30, 3600);
    return this.media.claim(request.imageAddress, body.role, body.cid);
  }
  @Post('submit')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  submit(@Req() request: ImageRequest, @Body() body: ImageSubmitDto) {
    return this.media.submit(request.imageAddress, body.id, body.signature);
  }
  @Get('writes/:id')
  @UseGuards(ProfileMediaGate, ProfileMediaSession)
  status(
    @Req() request: ImageRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.media.status(request.imageAddress, id);
  }
  @Get('writes/:id/status')
  @Header('Cache-Control', 'no-store')
  @UseGuards(ProfileMediaGate)
  recoveryStatus(
    @Query('address') address: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.media.recoveryStatus(address, id);
  }
  @Get('batch')
  @UseGuards(ProfileMediaGate)
  batch(@Query('addresses') addresses: string) {
    if (typeof addresses !== 'string' || addresses.length > 5000)
      throw new BadRequestException('Request up to 50 wallet addresses');
    return this.media.batch(addresses.split(','));
  }
}
