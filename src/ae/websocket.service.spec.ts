import {
  ACTIVE_NETWORK,
  WEB_SOCKET_CHANNELS,
  WEB_SOCKET_SUBSCRIBE,
  WEB_SOCKET_UNSUBSCRIBE,
} from '@/configs';
import {
  IMiddlewareWebSocketSubscriptionMessage,
  ITransaction,
} from '@/utils/types';
import { Test } from '@nestjs/testing';
import { v4 as genUuid } from 'uuid';
import { WebSocket } from 'ws';
import { WebSocketService } from './websocket.service';

jest.mock('ws', () => {
  const WebSocketMock = jest.fn().mockImplementation(() => ({
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    removeEventListener: jest.fn(),
    ping: jest.fn(),
    readyState: 1, // Simulate an "open" WebSocket
  }));

  return { WebSocket: WebSocketMock };
});

describe('WebSocketService', () => {
  let service: WebSocketService;
  let mockWsClient;
  const eventListeners = {};

  beforeEach(async () => {
    mockWsClient = {
      send: jest.fn(),
      close: jest.fn(),
      ping: jest.fn(),
      removeEventListener: jest.fn(),
      on: jest.fn((event, callback) => {
        eventListeners[event] = callback;
      }),
      readyState: 1, // Simulate an open WebSocket connection
    };

    (WebSocket as any).mockImplementation(() => mockWsClient);

    const module = await Test.createTestingModule({
      providers: [WebSocketService],
    }).compile();

    service = module.get<WebSocketService>(WebSocketService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should initialize WebSocket connection on creation', () => {
    expect(WebSocket).toHaveBeenCalledWith(ACTIVE_NETWORK.websocketUrl);
    expect(mockWsClient.on).toHaveBeenCalledWith('open', expect.any(Function));
  });

  it('should handle WebSocket open event and send queued subscriptions', () => {
    service.isWsConnected = false;
    service.subscribersQueue.push({
      op: 'Subscribe',
      payload: 'test',
    } as IMiddlewareWebSocketSubscriptionMessage);

    service.handleWebsocketOpen();

    expect(service.isWsConnected).toBe(true);
    expect(mockWsClient.send).toHaveBeenCalledWith(
      JSON.stringify({ op: 'Subscribe', payload: 'test' }),
    );
  });

  it('should handle WebSocket close event and attempt reconnection', () => {
    service.isWsConnected = true;
    (service as any).handleWebsocketClose();
    expect(service.isWsConnected).toBe(false);
    expect(WebSocket).toHaveBeenCalledWith(ACTIVE_NETWORK.websocketUrl);
  });

  it('should subscribe to a channel and return an unsubscribe function', () => {
    const callback = jest.fn();
    const message = {
      op: WEB_SOCKET_SUBSCRIBE,
      payload: WEB_SOCKET_CHANNELS.Transactions,
    } as IMiddlewareWebSocketSubscriptionMessage;

    const unsubscribe = service.subscribeForChannel(message, callback);

    expect(service.subscribers[message.payload]).toBeDefined();
    expect(Object.keys(service.subscribers[message.payload]).length).toBe(1);

    unsubscribe();
    expect(Object.keys(service.subscribers[message.payload]).length).toBe(0);
  });

  it('should unsubscribe when no more subscribers exist', () => {
    const message = {
      op: WEB_SOCKET_SUBSCRIBE,
      payload: WEB_SOCKET_CHANNELS.Transactions,
      source: 'mdw',
    } as IMiddlewareWebSocketSubscriptionMessage;

    const unsubscribe = service.subscribeForChannel(message, jest.fn());
    unsubscribe();

    expect(mockWsClient.send).toHaveBeenCalledWith(
      JSON.stringify({
        ...message,
        op: WEB_SOCKET_UNSUBSCRIBE,
        source: 'mdw',
      }),
    );
  });

  it('should handle WebSocket messages and notify subscribers', () => {
    const callback = jest.fn();
    const message = {
      op: WEB_SOCKET_SUBSCRIBE,
      payload: WEB_SOCKET_CHANNELS.Transactions,
    } as IMiddlewareWebSocketSubscriptionMessage;

    service.subscribeForChannel(message, callback);

    const payloadData: ITransaction = { hash: 'testHash' } as any;
    const wsMessage = JSON.stringify({
      subscription: message.payload,
      payload: payloadData,
    });

    (service as any).handleWebsocketMessage(wsMessage);

    expect(callback).toHaveBeenCalledWith(payloadData);
  });

  it('should handle PONG messages and remove processed pings', () => {
    const pingId = genUuid();
    service.pings.push({ id: pingId, timestamp: Date.now() });

    const pongMessage = JSON.stringify({ payload: { id: pingId } });

    // Retrieve the registered `pong` event callback
    const pongCallback = mockWsClient.on.mock.calls.find(
      ([event]) => event === 'pong',
    )?.[1];
    if (pongCallback) {
      pongCallback(pongMessage);
    }

    expect(service.pings.length).toBe(0);
  });
});
