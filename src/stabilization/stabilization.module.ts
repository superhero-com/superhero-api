import { Module } from '@nestjs/common';
import { StabilizationService } from './stabilization.service';

@Module({
  providers: [StabilizationService],
})
export class StabilizationModule {}
