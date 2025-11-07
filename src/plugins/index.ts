import { Provider } from '@nestjs/common';
import { MDW_PLUGIN } from './plugin.tokens';
import { BclPlugin } from './bcl/bcl.plugin';
import { SocialPlugin } from './social/social.plugin';

/**
 * Plugin registration provider factory
 * This exports the provider configuration for registering all plugins
 */
export const getPluginProvider = (): Provider => ({
  provide: MDW_PLUGIN,
  useFactory: (bclPlugin: BclPlugin, socialPlugin: SocialPlugin) => {
    return [bclPlugin, socialPlugin];
  },
  inject: [BclPlugin, SocialPlugin],
});

