import { Injectable, Logger } from '@nestjs/common';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import {
  ACTIVE_NETWORK,
  WEB_SOCKET_CHANNELS,
  WEB_SOCKET_RECONNECT_TIMEOUT,
  WEB_SOCKET_SOURCE,
  WEB_SOCKET_SUBSCRIBE,
  WEB_SOCKET_UNSUBSCRIBE,
} from '@/configs';
import { v4 as genUuid } from 'uuid';
import { WebSocket } from 'ws';

import {
  IMiddlewareWebSocketSubscriptionMessage,
  ITopHeader,
  ITransaction,
  WebSocketChannelName,
} from '@/utils/types';
import { Cron } from '@nestjs/schedule';
import { CronExpression } from '@nestjs/schedule';

type PingI = {
  id: string;
  timestamp: number;
};

@Injectable()
export class WebSocketService {
  private readonly logger = new Logger(WebSocketService.name);
  wsClient: WebSocket;
  subscribersQueue: IMiddlewareWebSocketSubscriptionMessage[] = [];
  isWsConnected = false;
  reconnectInterval: NodeJS.Timeout;

  pings = [];

  subscribers: Record<
    WebSocketChannelName,
    Record<string, (payload: ITransaction | ITopHeader) => void>
  > = {
    [WEB_SOCKET_CHANNELS.Transactions]: {},
    [WEB_SOCKET_CHANNELS.MicroBlocks]: {},
    [WEB_SOCKET_CHANNELS.KeyBlocks]: {},
    [WEB_SOCKET_CHANNELS.Object]: {},
  };

  constructor() {
    this.connect(ACTIVE_NETWORK.websocketUrl);
    this.setupReconnectionCheck();
  }

  async handleWebsocketOpen() {
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (this.wsClient.readyState === WebSocket.OPEN) {
          clearInterval(interval);
          resolve(true);
        }
      }, 100);
    });

    this.isWsConnected = true;
    try {
      this.subscribersQueue.forEach((message) => {
        this.wsClient.send(JSON.stringify(message));
      });
    } catch (error) {
      setTimeout(() => {
        this.handleWebsocketOpen();
      }, WEB_SOCKET_RECONNECT_TIMEOUT);
    }
  }

  private handleWebsocketClose() {
    this.isWsConnected = false;
    this.reconnect();
  }

  isConnected(): boolean {
    return this.isWsConnected;
  }

  private setupReconnectionCheck() {
    this.reconnectInterval = setInterval(() => {
      if (this.pings.length) {
        this.isWsConnected = false;
        this.reconnect();
        return;
      }
      const pingData: PingI = {
        id: genUuid(),
        timestamp: Date.now(),
      };
      this.pings.push(pingData);
      this.wsClient.ping(
        JSON.stringify({
          op: 'Ping',
          payload: pingData,
        }),
      );
    }, WEB_SOCKET_RECONNECT_TIMEOUT);
  }

  private reconnect() {
    if (!this.isWsConnected) {
      this.connect(ACTIVE_NETWORK.websocketUrl);
    }
  }

  subscribeForChannel(
    message: IMiddlewareWebSocketSubscriptionMessage,
    callback: (payload: any) => void,
  ) {
    if (this.isWsConnected) {
      try {
        this.wsClient.send(
          JSON.stringify({
            ...message,
            source: WEB_SOCKET_SOURCE.mdw,
          }),
        );
      } catch (error) {
        this.logger.error('subscribeForChannel->error::', error);
      }
    }

    this.subscribersQueue.push(message);

    const uuid = genUuid();
    this.subscribers[message.payload][uuid] = callback;
    return () => {
      delete this.subscribers[message.payload][uuid];
      if (Object.keys(this.subscribers[message.payload]).length === 0) {
        // should remove the message from the queue if there are no subscribers
        this.subscribersQueue = this.subscribersQueue.filter(
          (msg) => msg.payload !== message.payload,
        );

        // should unsubscribe from the channel if there are no subscribers
        Object.keys(WEB_SOCKET_SOURCE).forEach((source) => {
          this.wsClient.send(
            JSON.stringify({
              ...message,
              op: WEB_SOCKET_UNSUBSCRIBE,
              source,
            }),
          );
        });
      }
    };
  }

  subscribeForTransactionsUpdates(callback: (payload: ITransaction) => void) {
    return this.subscribeForChannel(
      {
        op: WEB_SOCKET_SUBSCRIBE,
        payload: WEB_SOCKET_CHANNELS.Transactions,
      },
      callback,
    );
  }

  subscribeForMicroBlocksUpdates(callback: (payload: ITopHeader) => void) {
    return this.subscribeForChannel(
      {
        op: WEB_SOCKET_SUBSCRIBE,
        payload: WEB_SOCKET_CHANNELS.MicroBlocks,
      },
      callback,
    );
  }

  subscribeForKeyBlocksUpdates(callback: (payload: ITopHeader) => void) {
    return this.subscribeForChannel(
      {
        op: WEB_SOCKET_SUBSCRIBE,
        payload: WEB_SOCKET_CHANNELS.KeyBlocks,
      },
      callback,
    );
  }

  private handleWebsocketMessage(message) {
    if (!message) {
      return;
    }
    // console.log('handleWebsocketMessage::', JSON.parse(message));
    try {
      const data: any = camelcaseKeysDeep(JSON.parse(message));

      if (!data.payload) {
        return;
      }

      // Call all subscribers for the channel
      Object.values(
        this.subscribers[data.subscription as WebSocketChannelName],
      ).forEach((subscriberCb) => subscriberCb(data.payload));
    } catch (error) {
      this.logger.error('handleWebsocketMessage->error::', error);
    }
  }

  disconnect() {
    try {
      this.subscribersQueue.forEach((message) => {
        Object.keys(WEB_SOCKET_SOURCE).forEach((source) => {
          this.wsClient.send(
            JSON.stringify({
              ...message,
              source,
              op: WEB_SOCKET_UNSUBSCRIBE,
            }),
          );
        });
      });
      this.wsClient.close();
      this.wsClient.removeEventListener('open', this.handleWebsocketOpen);
      this.wsClient.removeEventListener('close', this.handleWebsocketClose);
      this.wsClient.removeEventListener('message', this.handleWebsocketClose);
      clearInterval(this.reconnectInterval);
    } catch (error) {
      //
    }
  }

  connect(url: string) {
    if (this.wsClient) {
      this.disconnect();
    }

    this.wsClient = new WebSocket(url);
    this.wsClient.on('error', console.error);
    this.wsClient.on('open', this.handleWebsocketOpen.bind(this));
    this.wsClient.on('close', this.handleWebsocketClose.bind(this));
    this.wsClient.on('message', this.handleWebsocketMessage.bind(this));
    this.wsClient.on('pong', (data: any) => {
      const parsedData = JSON.parse(data.toString());
      const pingData = parsedData.payload;
      this.pings = this.pings.filter((ping) => ping.id !== pingData.id);
    });
    this.pings = [];
  }

  /**
   * Forces a reconnection to the WebSocket server.
   * This method disconnects the current WebSocket connection,
   * waits for 1 second to ensure complete disconnection,
   * and then reconnects to the server.
   *
   * @returns {Promise<void>}
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async forceReconnect() {
    this.logger.log('forceReconnect');
    if (this.isWsConnected) {
      this.disconnect();
      // Wait for 1 second to ensure complete disconnection
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.connect(ACTIVE_NETWORK.websocketUrl);
  }
}
