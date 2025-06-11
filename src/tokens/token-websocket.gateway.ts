import { OnModuleInit } from '@nestjs/common';
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';

import { Server } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class TokenWebsocketGateway implements OnModuleInit {
  @WebSocketServer()
  server: Server;

  onModuleInit() {
    // this.server.on('connection', (socket) => {
    //   console.log('connection', socket.id);
    // });
  }

  @SubscribeMessage('tokenUpdated')
  handleTokenUpdated(@MessageBody() payload: any): string {
    this.server.emit('token-updated', payload);
    return 'Done!';
  }

  @SubscribeMessage('tokenCreated')
  handleTokenCreated(@MessageBody() payload: any): string {
    this.server.emit('token-created', payload);
    return 'Done!';
  }

  @SubscribeMessage('tokenTransaction')
  handleTokenTransaction(@MessageBody() payload: any): string {
    this.server.emit('token-transaction', payload);
    return 'Done!';
  }

  @SubscribeMessage('tokenHistory')
  handleTokenHistory(@MessageBody() payload: any): string {
    this.server.emit('token-history', payload);
    return 'Done!';
  }
}
