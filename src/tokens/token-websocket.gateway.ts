import { OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';

import { Server } from 'socket.io';
import {
  hasExplicitAllowlist,
  parseAllowedOrigins,
} from '@/configs/allowed-origins';

/**
 * Broadcasts token lifecycle events to connected clients.
 *
 * There are intentionally no `@SubscribeMessage` handlers here. Previously
 * the gateway relayed any client-sent message straight back to every
 * connected client, which let anonymous callers poison the UI with
 * fabricated prices/events. All emissions must originate from server-side
 * services that have validated the payload (see `TokensService`,
 * `TransactionService`, `BclPluginSyncService`,
 * `plugins/bcl/services/token.service.ts`), which call these methods
 * directly via dependency injection.
 */
@WebSocketGateway({
  cors: {
    origin: parseAllowedOrigins(),
    credentials: hasExplicitAllowlist(),
  },
})
export class TokenWebsocketGateway implements OnModuleInit {
  @WebSocketServer()
  server: Server;

  onModuleInit() {
    //
  }

  handleTokenUpdated(payload: unknown): string {
    this.server.emit('token-updated', payload);
    return 'Done!';
  }

  handleTokenHistory(payload: unknown): string {
    this.server.emit('token-history', payload);
    return 'Done!';
  }
}
