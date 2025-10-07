import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from './entities/account.entity';
import { AccountService } from './services/account.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { AccountsController } from './controllers/accounts.controller';

@Module({
  imports: [AeModule, TransactionsModule, TypeOrmModule.forFeature([Account])],
  providers: [AccountService],
  exports: [TypeOrmModule],
  controllers: [AccountsController],
})
export class AccountModule {
  //
}
