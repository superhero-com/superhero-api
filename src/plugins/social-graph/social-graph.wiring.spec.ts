import { ConfigModule } from '@nestjs/config';
import { SocialGraphModule } from './social-graph.module';
import { SocialGraphPluginModule } from './social-graph-plugin.module';
import { SocialGraphController } from './social-graph.controller';
import { SocialGraphPlugin } from './social-graph.plugin';
import { SocialGraphReconcileService } from './services/social-graph-reconcile.service';
import { SocialGraphBackfillService } from './services/social-graph-backfill.service';
import { SocialGraphContractService } from './social-graph-contract.service';

// Import-and-reference so ts-jest type-checks the full wiring graph (controller,
// both modules, plugin, reconcile, contract service) — a compile smoke that
// stands in for the type check when the environment cannot run a full build.
describe('social-graph wiring', () => {
  it('resolves every module and provider symbol', () => {
    expect(SocialGraphModule).toBeDefined();
    expect(SocialGraphPluginModule).toBeDefined();
    expect(SocialGraphController).toBeDefined();
    expect(SocialGraphPlugin).toBeDefined();
    expect(SocialGraphReconcileService).toBeDefined();
    expect(SocialGraphBackfillService).toBeDefined();
    expect(SocialGraphContractService).toBeDefined();
  });

  // SocialGraphBackfillService injects ConfigService, so the module must import
  // ConfigModule (forRoot is not global here). Provider specs supply a mocked
  // ConfigService and so never caught its absence — the real container aborted
  // bootstrap on start.
  it('imports ConfigModule so ConfigService is injectable', () => {
    const imports = (Reflect.getMetadata('imports', SocialGraphPluginModule) ??
      []) as Array<{ module?: unknown } | unknown>;
    const wiresConfigModule = imports.some(
      (imported) =>
        imported === ConfigModule ||
        (imported as { module?: unknown })?.module === ConfigModule,
    );
    expect(wiresConfigModule).toBe(true);
  });
});
