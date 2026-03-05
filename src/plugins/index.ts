import { Provider, Type } from '@nestjs/common';
import { MDW_PLUGIN, POPULAR_RANKING_CONTRIBUTOR } from './plugin.tokens';
import { BclPlugin } from './bcl/bcl.plugin';
import { BclPluginModule } from './bcl/bcl-plugin.module';
import { SocialPlugin } from './social/social.plugin';
import { SocialPluginModule } from './social/social-plugin.module';
import { DexPlugin } from './dex/dex.plugin';
import { DexPluginModule } from './dex/dex-plugin.module';
import { SocialTippingPlugin } from './social-tipping/social-tipping.plugin';
import { SocialTippingPluginModule } from './social-tipping/social-tipping-plugin.module';
import { BclAffiliationPlugin } from './bcl-affiliation/bcl-affiliation.plugin';
import { BclAffiliationPluginModule } from './bcl-affiliation/bcl-affiliation-plugin.module';
import { GovernancePlugin } from './governance/governance.plugin';
import { GovernancePluginModule } from './governance/governance-plugin.module';
import { GovernancePopularRankingService } from './governance/services/governance-popular-ranking.service';
import { PopularRankingContributor } from './popular-ranking.interface';

/**
 * Export all plugin modules
 * Add new plugin modules here when registering a new plugin
 */
export const PLUGIN_MODULES: Type[] = [
  BclPluginModule,
  SocialPluginModule,
  DexPluginModule,
  SocialTippingPluginModule,
  BclAffiliationPluginModule,
  GovernancePluginModule,
];

/**
 * Plugin registration provider factory
 * This exports the provider configuration for registering all plugins
 * Add new plugins to the useFactory and inject arrays when registering a new plugin
 */
export const getPluginProvider = (): Provider => ({
  provide: MDW_PLUGIN,
  useFactory: (
    bclPlugin: BclPlugin,
    socialPlugin: SocialPlugin,
    dexPlugin: DexPlugin,
    socialTippingPlugin: SocialTippingPlugin,
    bclAffiliationPlugin: BclAffiliationPlugin,
    governancePlugin: GovernancePlugin,
  ) => {
    return [
      bclPlugin,
      socialPlugin,
      dexPlugin,
      socialTippingPlugin,
      bclAffiliationPlugin,
      governancePlugin,
    ];
  },
  inject: [
    BclPlugin,
    SocialPlugin,
    DexPlugin,
    SocialTippingPlugin,
    BclAffiliationPlugin,
    GovernancePlugin,
  ],
});

/**
 * Provider factory for popular ranking contributors
 * Collects all plugins that implement PopularRankingContributor
 */
export const getPopularRankingContributorProvider = (): Provider => ({
  provide: POPULAR_RANKING_CONTRIBUTOR,
  useFactory: (
    governanceRankingService: GovernancePopularRankingService,
  ): PopularRankingContributor[] => {
    return [governanceRankingService];
  },
  inject: [GovernancePopularRankingService],
});
