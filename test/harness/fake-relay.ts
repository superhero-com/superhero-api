import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * In-process NIP-42 relay for unit specs: drives the real nostr-tools client over a
 * loopback socket, so connection, AUTH and reconnect behaviour is tested without
 * an external relay.
 */
export interface FakeRelayOptions {
  /** Delay before the AUTH challenge after the socket opens; `null` never sends one. */
  challengeDelayMs?: number | null;
  /** Reject every AUTH with this OK reason. */
  rejectAuth?: string;
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
  openSockets(): number;
  /** Drop every open socket without a close handshake. */
  dropAll(): void;
  close(): Promise<void>;
}

export async function startFakeRelay(
  options: FakeRelayOptions = {},
): Promise<FakeRelay> {
  const { challengeDelayMs = 0, rejectAuth, onReq } = options;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const sockets = new Set<WebSocket>();
  const state = { connections: 0, authenticated: 0 };
  const reqs: Record<string, unknown>[][] = [];

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
    openSockets: () => sockets.size,
    dropAll: () => sockets.forEach((socket) => socket.terminate()),
    close: async () => {
      sockets.forEach((socket) => socket.terminate());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
