import { Module } from '@nestjs/common';
import { AeModule } from 'src/ae/ae.module';
import { TokenSaleService } from './token-sale.service';
import { TokensModule } from 'src/tokens/tokens.module';

@Module({
  imports: [AeModule, TokensModule],
  providers: [TokenSaleService],
  exports: [TokenSaleService],
})
export class TokenSaleModule {}
