import { Provider, Type } from '@nestjs/common';
import { MDW_PLUGIN } from './plugin.tokens';
import { BclPlugin } from './bcl/bcl.plugin';
import { BclPluginModule } from './bcl/bcl-plugin.module';
import { SocialPlugin } from './social/social.plugin';
import { SocialPluginModule } from './social/social-plugin.module';
import { DexPlugin } from './dex/dex.plugin';
import { DexPluginModule } from './dex/dex-plugin.module';
import { SocialTippingPlugin } from './social-tipping/social-tipping.plugin';
import { SocialTippingPluginModule } from './social-tipping/social-tipping-plugin.module';

/**
 * Export all plugin modules
 * Add new plugin modules here when registering a new plugin
 */
export const PLUGIN_MODULES: Type[] = [
  BclPluginModule,
  SocialPluginModule,
  DexPluginModule,
  SocialTippingPluginModule,
];

/**
 * Plugin registration provider factory
 * This exports the provider configuration for registering all plugins
 * Add new plugins to the useFactory and inject arrays when registering a new plugin
 */
export const getPluginProvider = (): Provider => ({
  provide: MDW_PLUGIN,
  useFactory: (bclPlugin: BclPlugin, socialPlugin: SocialPlugin, dexPlugin: DexPlugin, socialTippingPlugin: SocialTippingPlugin) => {
    return [bclPlugin, socialPlugin, dexPlugin, socialTippingPlugin];
  },
  inject: [BclPlugin, SocialPlugin, DexPlugin, SocialTippingPlugin],
});

