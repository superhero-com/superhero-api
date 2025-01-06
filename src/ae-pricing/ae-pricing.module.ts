import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CoinPrice } from './entities/coin-price.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CoinPrice])],
})
export class AePricingModule {}
