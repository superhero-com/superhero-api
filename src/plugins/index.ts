import { Provider, Type } from '@nestjs/common';
import { MDW_PLUGIN } from './plugin.tokens';
import { BclPlugin } from './bcl/bcl.plugin';
import { BclPluginModule } from './bcl/bcl-plugin.module';
import { SocialPlugin } from './social/social.plugin';
import { SocialPluginModule } from './social/social-plugin.module';

/**
 * Export all plugin modules
 * Add new plugin modules here when registering a new plugin
 */
export const PLUGIN_MODULES: Type[] = [
  BclPluginModule,
  SocialPluginModule,
];

/**
 * Plugin registration provider factory
 * This exports the provider configuration for registering all plugins
 * Add new plugins to the useFactory and inject arrays when registering a new plugin
 */
export const getPluginProvider = (): Provider => ({
  provide: MDW_PLUGIN,
  useFactory: (bclPlugin: BclPlugin, socialPlugin: SocialPlugin) => {
    return [bclPlugin, socialPlugin];
  },
  inject: [BclPlugin, SocialPlugin],
});

