import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { WebSocketService } from './ae/websocket.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private websocketService: WebSocketService,
  ) {}

  @Get('/api/stats')
  getApiStats() {
    return {
      apiVersion: this.appService.getApiVersion(),

      mdwConnected: this.websocketService.isConnected(),
    };
  }
}
