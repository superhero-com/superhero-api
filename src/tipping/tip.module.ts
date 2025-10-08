import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tip } from './entities/tip.entity';
import { TipService } from './services/tips.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { TipsController } from './controllers/tips.controller';
import { AccountModule } from '@/account/account.module';
import { PostModule } from '@/social/post.module';

@Module({
  imports: [
    AeModule,
    AccountModule,
    PostModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Tip]),
  ],
  providers: [TipService],
  exports: [TipService],
  controllers: [TipsController],
})
export class TipModule {
  //
}
