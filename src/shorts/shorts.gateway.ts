import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace } from 'socket.io';
import type { IncomingMessage } from 'node:http';
import { DataSource, QueryRunner } from 'typeorm';
import {
  hasExplicitAllowlist,
  parseAllowedOrigins,
} from '@/configs/allowed-origins';
import {
  ShortsIndexService,
  SHORTS_UPDATES_CHANNEL,
} from './shorts-index.service';
import { ShortsSocketService, SocketLease } from './shorts-socket.service';

const CHANNEL = SHORTS_UPDATES_CHANNEL;

// Server-originated invalidations only. PostgreSQL delivers them across API
// replicas, including replicas which did not hold the namespace writer lock.
@WebSocketGateway({
  namespace: '/shorts',
  path: '/shorts/socket.io',
  transports: ['websocket'],
  maxHttpBufferSize: 4096,
  connectTimeout: 5000,
  cors: { origin: parseAllowedOrigins(), credentials: hasExplicitAllowlist() },
})
export class ShortsGateway
  implements OnGatewayInit, OnApplicationBootstrap, OnModuleDestroy
{
  @WebSocketServer() server: Namespace;
  private readonly logger = new Logger(ShortsGateway.name);
  private runner?: QueryRunner;
  private retry?: NodeJS.Timeout;
  private stopped = false;
  private detach?: () => void;
  private heartbeat?: NodeJS.Timeout;
  private invalidation?: NodeJS.Timeout;
  private renewing?: Promise<void>;
  private nextRenewal = 0;
  private acquiring = 0;
  private readonly requests = new WeakMap<IncomingMessage, string>();
  private readonly engines = new WeakMap<object, string>();
  private readonly connections = new Map<
    string,
    { lease: SocketLease; close: () => void }
  >();
  private readonly releases = new Set<Promise<void>>();

  constructor(
    private readonly db: DataSource,
    private readonly index: ShortsIndexService,
    private readonly sockets: ShortsSocketService,
  ) {}

  afterInit(server: Namespace) {
    const origins = parseAllowedOrigins();
    const engine = server.server.engine;
    engine.use((request, _response, next) => {
      // This transport starts directly as WebSocket; it never upgrades polling
      // sessions. Reject SID reuse before Engine.IO's existing-session shortcut.
      const url = new URL(request.url || '/', 'http://localhost');
      next(
        url.searchParams.has('sid')
          ? new Error('Invalid Shorts session')
          : undefined,
      );
    });
    engine.opts.allowRequest = (request, done) => {
      if (
        this.stopped ||
        this.acquiring >= 32 ||
        this.connections.size + this.acquiring >=
          this.sockets.limits.nodeConnections ||
        (Array.isArray(origins) &&
          request.headers.origin &&
          !origins.includes(request.headers.origin))
      ) {
        done('Shorts live updates unavailable', false);
        return;
      }
      this.acquiring++;
      void this.sockets
        .acquire(request)
        .then((lease) => {
          if (!lease) {
            done('Shorts live updates busy', false);
            return;
          }
          if (
            this.stopped ||
            request.socket.destroyed ||
            performance.now() >= lease.deadline
          ) {
            this.release(lease);
            done('Shorts live updates unavailable', false);
            return;
          }
          this.connections.set(lease.id, {
            lease,
            close: () => request.socket.destroy(),
          });
          this.requests.set(request, lease.id);
          request.socket.once('close', () => this.drop(lease.id));
          done(null, true);
        })
        .catch(() => done('Shorts live updates unavailable', false))
        .finally(() => {
          this.acquiring--;
        });
    };
    engine.on('connection', (connection) => {
      const id = this.requests.get(connection.request);
      const entry = id && this.connections.get(id);
      if (!entry) {
        connection.close(true);
        return;
      }
      entry.close = () => connection.close(true);
      this.engines.set(connection, id);
      connection.once('close', () => {
        this.engines.delete(connection);
        this.drop(id);
      });
    });
    // This dedicated transport carries only server-originated invalidations.
    server.server
      .of('/')
      .use((_client, next) => next(new Error('Use the Shorts namespace')));
    server.use((client, next) =>
      next(
        this.live(client.conn)
          ? undefined
          : new Error('Shorts live updates unavailable'),
      ),
    );
    server.on('connection', (client) =>
      client.onAny(() => client.conn.close(true)),
    );
    this.nextRenewal = performance.now() + this.sockets.limits.renewMs;
    this.heartbeat = setInterval(() => {
      for (const [id, entry] of this.connections) {
        if (
          !this.sockets.healthy() ||
          performance.now() >= entry.lease.deadline
        ) {
          entry.close();
          this.drop(id);
        }
      }
      if (
        !this.stopped &&
        !this.renewing &&
        performance.now() >= this.nextRenewal
      ) {
        this.nextRenewal = performance.now() + this.sockets.limits.renewMs;
        this.renewing = this.renew().finally(() => {
          this.renewing = undefined;
        });
      }
    }, 1000);
    this.heartbeat.unref();
  }

  private release(lease: SocketLease) {
    const task = this.sockets.release(lease).catch(() => undefined);
    this.releases.add(task);
    void task.finally(() => this.releases.delete(task));
  }
  private drop(id: string) {
    const entry = this.connections.get(id);
    if (!entry) return;
    this.connections.delete(id);
    this.release(entry.lease);
  }
  private live(engine: object) {
    const id = this.engines.get(engine);
    const entry = id && this.connections.get(id);
    return (
      !this.stopped &&
      this.sockets.healthy() &&
      !!entry &&
      performance.now() < entry.lease.deadline
    );
  }
  private async renew() {
    const entries = [...this.connections.values()];
    try {
      for (
        let offset = 0;
        offset < entries.length && !this.stopped;
        offset += 64
      ) {
        const batch = entries.slice(offset, offset + 64);
        const alive = await this.sockets.renew(
          batch.map((entry) => entry.lease),
        );
        batch.forEach((entry) => {
          if (!alive.has(entry.lease.id)) {
            entry.close();
            this.drop(entry.lease.id);
          }
        });
      }
    } catch {
      entries.forEach((entry) => {
        entry.close();
        this.drop(entry.lease.id);
      });
    }
  }
  private broadcast() {
    if (this.stopped) return;
    const identity = this.index.identity();
    for (const socket of this.server?.sockets.values() || []) {
      if (this.live(socket.conn))
        socket.volatile.emit('shorts-updated', identity);
      else socket.conn.close(true);
    }
  }
  private invalidate() {
    if (this.stopped || this.invalidation) return;
    this.invalidation = setTimeout(() => {
      this.invalidation = undefined;
      this.broadcast();
    }, 100);
    this.invalidation.unref();
  }

  async onApplicationBootstrap() {
    await this.listen();
  }

  private async listen() {
    if (this.stopped) return;
    const runner = this.db.createQueryRunner();
    this.runner = runner;
    try {
      const client = await runner.connect();
      const notification = (message) => {
        if (message.channel !== CHANNEL || !message.payload) return;
        try {
          const payload = JSON.parse(message.payload);
          const identity = this.index.identity();
          if (
            payload.network !== identity.network ||
            payload.contract !== identity.contract
          )
            return;
          this.invalidate();
        } catch {
          this.logger.warn('Invalid Shorts notification');
        }
      };
      const reconnect = () => {
        if (this.stopped || this.runner !== runner) return;
        this.detach?.();
        this.detach = undefined;
        this.runner = undefined;
        void runner.release().catch(() => undefined);
        this.scheduleReconnect();
      };
      this.detach = () => {
        client.removeListener('notification', notification);
        client.removeListener('error', reconnect);
        client.removeListener('end', reconnect);
      };
      client.on('notification', notification);
      client.once('error', reconnect);
      client.once('end', reconnect);
      await runner.query(`LISTEN ${CHANNEL}`);
      // A disconnected listener may have missed invalidations. Refetch once.
      this.invalidate();
    } catch (error) {
      this.detach?.();
      this.detach = undefined;
      await runner.release().catch(() => undefined);
      this.runner = undefined;
      this.logger.warn(
        `Shorts notification listener reconnecting: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.listen();
    }, 1000);
    this.retry.unref?.();
  }

  async changed() {
    await this.db.query('SELECT pg_notify($1,$2)', [
      CHANNEL,
      JSON.stringify(this.index.identity()),
    ]);
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.invalidation) clearTimeout(this.invalidation);
    await this.renewing;
    for (const [id, entry] of this.connections) {
      entry.close();
      this.drop(id);
    }
    await Promise.allSettled(this.releases);
    if (this.retry) clearTimeout(this.retry);
    this.detach?.();
    this.detach = undefined;
    if (this.runner) {
      await this.runner.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      await this.runner.release().catch(() => undefined);
      this.runner = undefined;
    }
  }
}
