import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WebSocket } from 'ws';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Token } from './token.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'root',
      password: '',
      database: 'tokenae_scan',
      entities: [Token],
      // shouldn't be used in production - otherwise you can lose production data.
      synchronize: true,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {
  onModuleInit() {
    console.log('The module has been initialized.');
    const ws = new WebSocket('wss://testnet.aeternity.io/mdw/v2/websocket');
    ws.on('error', console.error);

    ws.on('open', function open() {
      console.log('connected');
      ws.send(
        JSON.stringify({
          payload: 'MicroBlocks',
          op: 'Subscribe',
        }),
      );
    });

    ws.on('message', function message(data) {
      console.log('received: ', JSON.parse(data));
    });
  }
}
