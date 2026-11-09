import type { AddressInfo } from 'node:net';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Event as NostrEvent } from 'nostr-tools';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * In-process NIP-42 relay for unit specs: drives the real nostr-tools client over a
 * loopback socket, so connection, AUTH and reconnect behaviour is tested without
 * an external relay.
 */
export interface FakeRelayOptions {
  /** Override HTTP handling to exercise unavailable or stalled NIP-11 endpoints. */
  onHttp?: (request: IncomingMessage, response: ServerResponse) => void;
  /** Serve NIP-11 over the same HTTP endpoint as the WebSocket relay. */
  relayInfo?: (request: IncomingMessage) => { pubkey?: string };
  /** Delay before the AUTH challenge after the socket opens; `null` never sends one. */
  challengeDelayMs?: number | null;
  /** Reject every AUTH with this OK reason. */
  rejectAuth?: string;
  /** Answer an EVENT publish. The default accepts it. */
  onEvent?: (send: (message: unknown[]) => void, event: NostrEvent) => void;
  /** Answer a REQ. The default replies EOSE. */
  onReq?: (
    send: (message: unknown[]) => void,
    subId: string,
    filters: Record<string, unknown>[],
  ) => void;
}

export interface FakeRelay {
  readonly url: string;
  /** Sockets accepted so far. */
  readonly connections: number;
  /** AUTH events accepted so far. */
  readonly authenticated: number;
  /** Filters of every REQ received, in arrival order. */
  readonly reqs: Record<string, unknown>[][];
  /** Published events (excluding AUTH), in arrival order. */
  readonly events: NostrEvent[];
  openSockets(): number;
  /** Drop every open socket without a close handshake. */
  dropAll(): void;
  close(): Promise<void>;
}

export async function startFakeRelay(
  options: FakeRelayOptions = {},
): Promise<FakeRelay> {
  const { challengeDelayMs = 0, rejectAuth, onReq, onEvent } = options;
  const httpServer = createServer((request, response) => {
    if (options.onHttp) {
      options.onHttp(request, response);
      return;
    }
    if (options.relayInfo) {
      response.writeHead(200, { 'Content-Type': 'application/nostr+json' });
      response.end(JSON.stringify(options.relayInfo(request)));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const server = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );
  const sockets = new Set<WebSocket>();
  const state = { connections: 0, authenticated: 0 };
  const reqs: Record<string, unknown>[][] = [];
  const events: NostrEvent[] = [];

  server.on('connection', (socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const send = (message: unknown[]): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };
    const challenge = `challenge-${state.connections}`;
    if (challengeDelayMs !== null) {
      setTimeout(() => send(['AUTH', challenge]), challengeDelayMs);
    }

    socket.on('message', (raw) => {
      const [type, ...rest] = JSON.parse(raw.toString());
      if (type === 'AUTH') {
        const event = rest[0];
        const signed = event.tags.some(
          (tag: string[]) => tag[0] === 'challenge' && tag[1] === challenge,
        );
        const reason =
          rejectAuth ?? (signed ? '' : 'auth-required: challenge mismatch');
        if (!reason) state.authenticated += 1;
        send(['OK', event.id, !reason, reason]);
      } else if (type === 'EVENT') {
        const event = rest[0] as NostrEvent;
        events.push(event);
        if (onEvent) onEvent(send, event);
        else send(['OK', event.id, true, '']);
      } else if (type === 'REQ') {
        const [subId, ...filters] = rest;
        reqs.push(filters);
        if (onReq) onReq(send, subId, filters);
        else send(['EOSE', subId]);
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get connections() {
      return state.connections;
    },
    get authenticated() {
      return state.authenticated;
    },
    reqs,
    events,
    openSockets: () => sockets.size,
    dropAll: () => sockets.forEach((socket) => socket.terminate()),
    close: async () => {
      sockets.forEach((socket) => socket.terminate());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
