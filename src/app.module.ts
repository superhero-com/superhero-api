import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from './ae/ae.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TokenSaleModule } from './token-sale/token-sale.module';
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
    AeModule,
    TokenSaleModule,
    TokensModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
