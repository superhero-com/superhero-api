import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Request } from 'express';
import { ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { AeAccountAddressPipe } from '@/common/validation/request-validation';
import notificationsConfig from '../notifications.config';
import { extractBearerToken } from '../notifications.constants';
import { DeviceChallengeService } from '../services/device-challenge.service';
import { FeedSessionService } from '../services/feed-session.service';
import { NotificationFeedService } from '../services/notification-feed.service';
import { NotificationsGateway } from '../notifications.gateway';
import { FeedSessionGuard } from '../guards/feed-session.guard';
import { CreateFeedSessionDto } from '../dto/create-feed-session.dto';
import { MarkReadDto } from '../dto/mark-read.dto';
import { toFeedItemView } from '../dto/feed-item.view.dto';
import {
  FeedListView,
  FeedSessionView,
  UnreadCountView,
} from '../dto/feed-response.view.dto';

/**
 * Web in-app notification feed. Two public bootstrap routes (challenge + session)
 * exchange one æternity signature for a bearer session; every read/mutation
 * after that is `FeedSessionGuard`-protected and scoped to the path address.
 */
@ApiTags('notifications')
@Controller('notifications')
export class FeedController {
  private readonly logger = new Logger(FeedController.name);

  constructor(
    private readonly challenges: DeviceChallengeService,
    private readonly sessions: FeedSessionService,
    private readonly feed: NotificationFeedService,
    private readonly gateway: NotificationsGateway,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  /** Issue a nonce the user signs into the feed-session message. */
  @Post(':address/feed/challenge')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  async requestChallenge(
    @Param('address', AeAccountAddressPipe) address: string,
  ) {
    return this.challenges.issue(address);
  }

  /**
   * Verify the signed challenge and mint a bearer session. The body is bound to
   * the feed-session message, so a captured nonce can't be replayed for another
   * intent.
   */
  @Post(':address/feed/session')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @ApiOkResponse({ type: FeedSessionView })
  async createSession(
    @Param('address', AeAccountAddressPipe) address: string,
    @Body() dto: CreateFeedSessionDto,
  ): Promise<FeedSessionView> {
    await this.challenges.verifyAndConsumeForSession(
      dto.nonce,
      address,
      dto.signature,
    );
    const { token, expiresAt } = await this.sessions.mint(address);
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Revoke the CALLING session (logout). `FeedSessionGuard` already proved the
   * bearer is valid and owned by `:address`, so this simply deletes it — the
   * Redis-backed opaque-token design (see FeedSessionService) exists precisely
   * so a session can be invalidated instantly. Note this does not kick an
   * already-open socket handshake made with this token (see
   * docs/notifications-web-feed.md); the token itself stops working for REST
   * and any *new* socket connection immediately.
   */
  @Delete(':address/feed/session')
  @HttpCode(200)
  @UseGuards(FeedSessionGuard)
  async revokeSession(
    @Param('address', AeAccountAddressPipe) address: string,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    // FeedSessionGuard already validated this header resolves to `address`.
    const token = extractBearerToken(request.headers.authorization) as string;
    await this.sessions.revoke(token);
    return { ok: true };
  }

  /** Newest-first page of this address's feed (session-scoped). */
  @Get(':address/feed')
  @UseGuards(FeedSessionGuard)
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: Number,
    description:
      'Id of the last item from the previous page; omit for the newest page.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size, clamped to NOTIF_FEED_MAX_PAGE_SIZE.',
  })
  @ApiOkResponse({ type: FeedListView })
  async list(
    @Param('address', AeAccountAddressPipe) address: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<FeedListView> {
    const page = await this.feed.listFor(address, {
      cursor: this.parseCursor(cursor),
      limit: this.parseLimit(limit),
    });
    return {
      items: page.items.map(toFeedItemView),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':address/feed/unread-count')
  @UseGuards(FeedSessionGuard)
  @ApiOkResponse({ type: UnreadCountView })
  async unreadCount(
    @Param('address', AeAccountAddressPipe) address: string,
  ): Promise<UnreadCountView> {
    return { count: await this.feed.unreadCount(address) };
  }

  /** Mark some/all items read; pushes the new unread badge over the socket. */
  @Post(':address/feed/read')
  @HttpCode(200)
  @UseGuards(FeedSessionGuard)
  @ApiOkResponse({ type: UnreadCountView })
  async markRead(
    @Param('address', AeAccountAddressPipe) address: string,
    @Body() dto: MarkReadDto,
  ): Promise<UnreadCountView> {
    const count = await this.feed.markRead(address, dto.ids);
    // Best-effort badge push: the mark-read is already committed, so never let a
    // socket emit failure (server not ready, adapter error) turn a successful
    // request into a 500 — the client reconciles the count on its next fetch.
    try {
      this.gateway.emitUnreadCount(address, count);
    } catch (error) {
      this.logger.warn(
        `Live unread-count emit failed for ${address}: ${
          (error as Error).message
        }`,
      );
    }
    return { count };
  }

  /** Clamp the requested page size to [1, feedMaxPageSize]. */
  private parseLimit(raw?: string): number {
    const max = this.config.feedMaxPageSize;
    const parsed = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return max;
    }
    return Math.min(parsed, max);
  }

  /** A non-positive / unparseable cursor means "from the top". */
  private parseCursor(raw?: string): number | undefined {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
}
