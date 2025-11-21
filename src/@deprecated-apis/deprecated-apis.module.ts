import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BclPluginModule } from '@/plugins/bcl/bcl-plugin.module';
import { TokenPerformanceController } from './controllers/token-performance.controller';
import { DeprecatedTokensController } from './controllers/tokens.controller';
import { BclTokenPerformanceView } from '@/plugins/bcl/entities/bcl-token-performance.view';

@Module({
  imports: [
    TypeOrmModule.forFeature([BclTokenPerformanceView]),
    BclPluginModule,
  ],
  controllers: [TokenPerformanceController, DeprecatedTokensController],
  providers: [],
  exports: [],
})
export class DeprecatedApisModule {}

