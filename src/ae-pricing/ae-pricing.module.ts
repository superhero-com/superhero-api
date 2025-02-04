import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoinPrice } from './entities/coin-price.entity';
import { AePricingService } from './ae-pricing.service';
import { AeModule } from '@/ae/ae.module';

@Module({
  imports: [TypeOrmModule.forFeature([CoinPrice]), AeModule],
  providers: [AePricingService],
  exports: [AePricingService],
})
export class AePricingModule {}
