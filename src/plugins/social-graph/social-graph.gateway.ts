import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { DataSource, QueryRunner } from 'typeorm';
import {
  hasExplicitAllowlist,
  parseAllowedOrigins,
} from '@/configs/allowed-origins';
import { ProjectionScope } from './social-graph-projection.service';
import { SocialGraphService } from './social-graph.service';

const CHANNEL = 'social_graph_updated';

// Server-originated invalidations only. PostgreSQL delivers them across API
// replicas, including replicas which did not hold the namespace writer lock.
@WebSocketGateway({
  cors: { origin: parseAllowedOrigins(), credentials: hasExplicitAllowlist() },
})
export class SocialGraphGateway
  implements OnApplicationBootstrap, OnModuleDestroy
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(SocialGraphGateway.name);
  private runner?: QueryRunner;
  private retry?: NodeJS.Timeout;
  private stopped = false;
  private detach?: () => void;

  constructor(
    private readonly db: DataSource,
    private readonly graph: SocialGraphService,
  ) {}

  async onApplicationBootstrap() {
    if (this.graph.isConfigured()) await this.listen();
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
          const identity = this.graph.getReader().identity;
          if (
            payload.network !== identity.network ||
            payload.contract !== identity.contract
          )
            return;
          this.server?.emit('social-graph-updated', payload);
        } catch {
          this.logger.warn('Invalid social graph notification');
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
      this.server?.emit(
        'social-graph-updated',
        this.graph.getReader().identity,
      );
    } catch (error) {
      this.detach?.();
      this.detach = undefined;
      await runner.release().catch(() => undefined);
      this.runner = undefined;
      this.logger.warn(
        `Social graph notification listener reconnecting: ${error instanceof Error ? error.message : String(error)}`,
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

  async changed(scope: ProjectionScope, accounts?: string[]) {
    const payload = {
      ...scope,
      ...(accounts && accounts.length <= 80 ? { accounts } : {}),
    };
    await this.db.query('SELECT pg_notify($1,$2)', [
      CHANNEL,
      JSON.stringify(payload),
    ]);
  }

  async onModuleDestroy() {
    this.stopped = true;
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
