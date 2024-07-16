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
export class TokensGateway implements OnModuleInit {
  @WebSocketServer()
  server: Server;

  onModuleInit() {
    this.server.on('connection', (socket) => {
      console.log('connection', socket.id);
    });
  }

  @SubscribeMessage('tokenUpdate')
  handleTokenUpdate(@MessageBody() payload: any): string {
    // console.log('handleTokenUpdate', payload);
    this.server.emit('token-update', payload);
    return 'Done!';
  }
}
