import { Module } from '@nestjs/common';
import { WebSocketService } from './websocket.service';
import { AeSdkService } from './ae-sdk.service';

@Module({
  providers: [WebSocketService, AeSdkService],
  exports: [WebSocketService, AeSdkService],
})
export class AeModule {}
