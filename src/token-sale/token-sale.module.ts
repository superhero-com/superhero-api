import { Module } from '@nestjs/common';
import { AeModule } from 'src/ae/ae.module';
import { TokenSaleService } from './token-sale.service';
import { TokensModule } from 'src/tokens/tokens.module';
import { TokenSaleDataSyncService } from './token-sale-data-sync.service';

@Module({
  imports: [AeModule, TokensModule],
  providers: [TokenSaleService, TokenSaleDataSyncService],
  exports: [TokenSaleService],
})
export class TokenSaleModule {}
