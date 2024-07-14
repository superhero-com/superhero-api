import camelcaseKeysDeep from 'camelcase-keys-deep';
import { v4 as genUuid } from 'uuid';

import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import {
  WEB_SOCKET_CHANNELS,
  WEB_SOCKET_RECONNECT_TIMEOUT,
  WEB_SOCKET_SOURCE,
  WEB_SOCKET_SUBSCRIBE,
  WEB_SOCKET_UNSUBSCRIBE,
} from './utils/constants';
import {
  IMiddlewareWebSocketSubscriptionMessage,
  ITopHeader,
  ITransaction,
  WebSocketChannelName,
} from './utils/types';
import { ACTIVE_NETWORK } from './utils/networks';

@Injectable()
export class WebSocketService {
  wsClient: WebSocket;
  subscribersQueue: IMiddlewareWebSocketSubscriptionMessage[] = [];
  isWsConnected = false;
  reconnectInterval: NodeJS.Timeout;

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

  handleWebsocketOpen() {
    this.isWsConnected = true;
    try {
      this.subscribersQueue.forEach((message) => {
        this.wsClient.send(JSON.stringify(message));
      });
    } catch (error) {
      console.log(error);
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
      if (!this.isWsConnected) {
        this.reconnect();
      }
    }, WEB_SOCKET_RECONNECT_TIMEOUT);
  }

  private reconnect() {
    if (!this.isWsConnected) {
      console.log('Attempting to reconnect...');
      this.connect(ACTIVE_NETWORK.websocketUrl);
    }
  }

  subscribeForChannel(
    message: IMiddlewareWebSocketSubscriptionMessage,
    callback: (payload: any) => void,
  ) {
    if (this.isWsConnected) {
      Object.keys(WEB_SOCKET_SOURCE).forEach((source) => {
        try {
          this.wsClient.send(
            JSON.stringify({
              ...message,
              source,
            }),
          );
        } catch (error) {
          console.log('ERROR subscribeForChannel:', error);
        }
      });
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
      console.log(error);
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
  }
}
