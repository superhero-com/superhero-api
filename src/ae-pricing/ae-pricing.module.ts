import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoinPrice } from './entities/coin-price.entity';
import { CoinHistoricalPrice } from './entities/coin-historical-price.entity';
import { AePricingService } from './ae-pricing.service';
import { CoinHistoricalPriceService } from './services/coin-historical-price.service';
import { AeModule } from '@/ae/ae.module';
import { PriceFeedController } from './controllers/price-feed.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([CoinPrice, CoinHistoricalPrice]),
    forwardRef(() => AeModule),
  ],
  controllers: [PriceFeedController],
  providers: [AePricingService, CoinHistoricalPriceService],
  exports: [AePricingService, CoinHistoricalPriceService],
})
export class AePricingModule {}
