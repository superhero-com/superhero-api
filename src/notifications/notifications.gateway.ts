import { Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  hasExplicitAllowlist,
  parseAllowedOrigins,
} from '@/configs/allowed-origins';
import { resolveClientIp } from '@/configs/client-ip';
import notificationsConfig from './notifications.config';
import { extractBearerToken } from './notifications.constants';
import { FeedItemView } from './dto/feed-item.view.dto';
import { FeedSessionService } from './services/feed-session.service';

/**
 * Real-time delivery for the web feed. Best-effort by design: the persisted feed
 * is the source of truth, so a dropped emit (no open tab, or — once the app is
 * scaled past one replica — a socket on a different instance with no Redis
 * adapter) is self-healing because the client re-lists the feed on (re)connect.
 *
 * Like TokenWebsocketGateway there are deliberately **no `@SubscribeMessage`
 * handlers** — clients never push data in; they read history and mark-read over
 * the authenticated REST endpoints. The only emissions originate server-side
 * from the DatabaseChannel / FeedController via `emitToAddress` / `emitUnreadCount`.
 *
 * Auth: the socket handshake must carry the same bearer session minted from an
 * æternity signature (`auth.token`, or `Authorization: Bearer`). The connection
 * joins a room named after the proven address; emits target that room, so one
 * address's notifications never reach another's sockets.
 */
@WebSocketGateway({
  namespace: 'notifications',
  cors: {
    origin: parseAllowedOrigins(),
    credentials: hasExplicitAllowlist(),
  },
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  /** In-memory per-address connection counter (single-container deploy). */
  private readonly connectionsByAddress = new Map<string, number>();

  /**
   * In-memory per-IP handshake-attempt limiter (single-container deploy).
   * Bounds anonymous/junk-token connection attempts BEFORE they cost a Redis
   * session lookup — `connectionsByAddress` only ever counts sockets that
   * resolved to a real address, so without this a flood of junk tokens from
   * one IP is entirely unbounded at the app layer.
   */
  private readonly handshakeAttemptsByIp = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(
    private readonly sessions: FeedSessionService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // `handshake.address` is the raw TCP peer (engine.io reads it straight
    // off the socket) and knows nothing about TRUST_PROXY/X-Forwarded-For —
    // behind a reverse proxy every connection's raw peer is the proxy
    // itself, so this resolves the real client IP the same way Express's
    // `req.ip` does, or falls back to the raw peer when no proxy is trusted.
    const ip = resolveClientIp(
      client.handshake.headers,
      client.handshake.address,
    );
    if (!this.allowHandshake(ip)) {
      this.logger.warn(`Socket handshake cap hit for ${ip}`);
      client.disconnect(true);
      return;
    }
    const token = this.extractToken(client);
    const address = token ? await this.sessions.resolve(token) : null;
    if (!address) {
      client.disconnect(true);
      return;
    }
    if (!client.connected) {
      // The socket dropped WHILE we were awaiting the session lookup above.
      // Its 'disconnect' event already fired and found no `client.data.address`
      // (we hadn't set it yet), so `handleDisconnect` no-op'd — no slot was ever
      // taken, and no further disconnect event will ever fire for this socket.
      // Stopping here (before touching the counter / calling join()) is what
      // prevents a permanent, unreleasable slot leak.
      return;
    }

    const current = this.connectionsByAddress.get(address) ?? 0;
    if (current >= this.config.socketMaxConnsPerAddress) {
      this.logger.warn(`Socket connection cap hit for ${address}`);
      client.disconnect(true);
      return;
    }

    this.connectionsByAddress.set(address, current + 1);
    try {
      await client.join(address);
      // Stash the address ONLY on a successful join — so `handleDisconnect`
      // (fired by Nest for every socket disconnect, INCLUDING the
      // `client.disconnect(true)` below on a failed join) knows to decrement
      // this slot. If we set it before the join attempt, a failed join would
      // release the slot manually in the catch block below AND, again, via
      // `handleDisconnect` — a double release that undercounts live
      // connections and silently widens the per-address cap.
      client.data.address = address;
    } catch (error) {
      // join() can reject (adapter error / socket already closing). `client.data
      // .address` was never set above, so `handleDisconnect` no-ops for this
      // socket — release the slot exactly once, here.
      this.releaseSlot(address);
      this.logger.warn(
        `Socket join failed for ${address}: ${(error as Error).message}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const address = client.data?.address as string | undefined;
    if (!address) {
      return;
    }
    this.releaseSlot(address);
  }

  /** Decrement (and prune at zero) the per-address connection counter. */
  private releaseSlot(address: string): void {
    const current = this.connectionsByAddress.get(address) ?? 0;
    if (current <= 1) {
      this.connectionsByAddress.delete(address);
    } else {
      this.connectionsByAddress.set(address, current - 1);
    }
  }

  /** Rolling per-IP window; true iff this attempt is still under the cap. */
  private allowHandshake(ip: string): boolean {
    const now = Date.now();
    if (this.handshakeAttemptsByIp.size > 1000) {
      for (const [key, entry] of this.handshakeAttemptsByIp.entries()) {
        if (now > entry.resetAt) {
          this.handshakeAttemptsByIp.delete(key);
        }
      }
    }

    const entry = this.handshakeAttemptsByIp.get(ip);
    if (!entry || now > entry.resetAt) {
      this.handshakeAttemptsByIp.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= this.config.socketMaxHandshakesPerIpPerMinute) {
      return false;
    }
    entry.count += 1;
    return true;
  }

  /** Push a newly-persisted feed item to the recipient's open tabs. */
  emitToAddress(address: string, item: FeedItemView): void {
    this.server.to(address).emit('notification', item);
  }

  /** Push the updated unread badge value (e.g. after a mark-read). */
  emitUnreadCount(address: string, count: number): void {
    this.server.to(address).emit('unread-count', { count });
  }

  private extractToken(client: Socket): string | null {
    const fromAuth = client.handshake.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth.length > 0) {
      return fromAuth;
    }
    return extractBearerToken(client.handshake.headers?.authorization);
  }
}
