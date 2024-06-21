import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Token } from './entities/token.entity';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { TokenHistory } from './entities/token-history.entity';
import { TokensGateway } from './tokens.gateway';
import { HistoricalController } from './historical.controller';
import { TokenHistoryService } from './token-history.service';

@Module({
  imports: [TypeOrmModule.forFeature([Token, TokenHistory])],
  controllers: [TokensController, HistoricalController],
  providers: [TokensService, TokenHistoryService, TokensGateway],
  exports: [TypeOrmModule, TokensService],
})
export class TokensModule {
  onModuleInit() {
    //
  }
}
