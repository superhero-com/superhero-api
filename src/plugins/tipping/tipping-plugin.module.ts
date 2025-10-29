import { MDW_PLUGIN } from '@/mdw/plugins/plugin.tokens';
import { Tip } from '@/plugins/tipping/entities/tip.entity';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TippingPlugin } from './tipping.plugin';
import { AeModule } from '@/ae/ae.module';
import { AccountModule } from '@/account/account.module';
import { TipsController } from './controllers/tips.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Tip])],
  providers: [
    AeModule,
    AccountModule,
    TippingPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: TippingPlugin,
    },
  ],
  exports: [TippingPlugin, TypeOrmModule],
  controllers: [TipsController],
})
export class TippingPluginModule {
  //
}
