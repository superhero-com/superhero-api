import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from 'src/ae/ae.module';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

@Module({
  imports: [TypeOrmModule.forFeature([Token, TokenHolder]), AeModule],
  controllers: [TokensController],
  providers: [TokensService, TokenWebsocketGateway],
  exports: [TypeOrmModule, TokensService, TokenWebsocketGateway],
})
export class TokensModule {
  onModuleInit() {
    //
  }
}
