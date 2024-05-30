import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WebSocket } from 'ws';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TokensModule } from './tokens/tokens.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'root',
      password: '',
      database: 'tokenae_scan',
      entities: [__dirname + '/**/entities/*.entity{.ts,.js}'],
      // shouldn't be used in production - otherwise you can lose production data.
      synchronize: true,
    }),
    TokensModule,
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
