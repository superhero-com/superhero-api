import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plugin, PluginFilter } from '@/plugins/plugin.interface';
import { MDW_PLUGIN } from '@/plugins/plugin.tokens';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';

@Injectable()
export class PluginRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PluginRegistryService.name);
  private plugins: Plugin[] = [];

  constructor(
    @Inject(MDW_PLUGIN) private readonly pluginProviders: Plugin[],
    @InjectRepository(PluginSyncState)
    private pluginSyncStateRepository: Repository<PluginSyncState>,
  ) {
    this.plugins = pluginProviders || [];
    this.logger.log(`Registered ${this.plugins.length} plugins`);
  }

  async onModuleInit() {
    // Initialize plugin sync states on module init to ensure they exist before any indexing starts
    await this.initializePluginSyncStates();
    // Auto-update plugin data for all plugins
    void this.autoUpdatePluginData();
  }

  getPlugins(): Plugin[] {
    return this.plugins;
  }

  getPluginByName(name: string): Plugin | undefined {
    return this.plugins.find((plugin) => plugin.name === name);
  }

  getAllFilters(): PluginFilter[] {
    const allFilters: PluginFilter[] = [];

    for (const plugin of this.plugins) {
      const pluginFilters = plugin.filters();
      allFilters.push(...pluginFilters);
    }

    return allFilters;
  }

  getUniqueContractIds(): string[] {
    const contractIds = new Set<string>();

    for (const filter of this.getAllFilters()) {
      if (filter.contractIds) {
        filter.contractIds.forEach((id) => contractIds.add(id));
      }
    }

    return Array.from(contractIds);
  }

  getUniqueFunctions(): string[] {
    const functions = new Set<string>();

    for (const filter of this.getAllFilters()) {
      if (filter.functions) {
        filter.functions.forEach((func) => functions.add(func));
      }
    }

    return Array.from(functions);
  }

  getUniqueTypes(): string[] {
    const types = new Set<string>();

    for (const filter of this.getAllFilters()) {
      if (filter.type) {
        types.add(filter.type);
      }
    }

    return Array.from(types);
  }

  /**
   * Initialize sync states for all registered plugins
   * Ensures all plugins have a sync state before indexing starts
   */
  async initializePluginSyncStates(): Promise<void> {
    this.logger.log('Initializing plugin sync states...');

    for (const plugin of this.plugins) {
      try {
        const startFromHeight = plugin.startFromHeight();
        
        // Always use upsert to atomically insert or update, preventing race conditions
        // This ensures only one record exists per plugin_name even if called concurrently
        // We use upsert with conflictPaths to handle the primary key constraint
        // skipUpdateIfNoValuesChanged: true means it will only INSERT if new, not UPDATE existing
        await this.pluginSyncStateRepository.upsert(
          {
            plugin_name: plugin.name,
            version: plugin.version,
            last_synced_height: startFromHeight - 1,
            backward_synced_height: null, // Will be set when backward sync starts
            live_synced_height: null, // Will be set when live sync starts
            start_from_height: startFromHeight,
          },
          {
            conflictPaths: ['plugin_name'],
            // Only insert if new, don't update existing records (we handle updates separately below)
            skipUpdateIfNoValuesChanged: true,
          },
        );
        
        // After upsert, fetch the current state to check if version needs updating
        const existing = await this.pluginSyncStateRepository.findOne({
          where: { plugin_name: plugin.name },
        });
        
        if (existing) {
          // Check if version changed - if so, reset sync state
          if (existing.version !== plugin.version) {
            this.logger.log(
              `Plugin ${plugin.name} version changed from ${existing.version} to ${plugin.version}, resetting sync state`,
            );
            const startFromHeight = plugin.startFromHeight();
            await this.pluginSyncStateRepository.update(
              { plugin_name: plugin.name },
              {
                version: plugin.version,
                last_synced_height: startFromHeight - 1,
                backward_synced_height: null, // Reset to trigger re-sync
                live_synced_height: null, // Reset to trigger re-sync
                start_from_height: startFromHeight,
              },
            );
          } else {
            // Ensure backward_synced_height and live_synced_height are initialized if null
            const updateData: Partial<PluginSyncState> = {};
            if (existing.backward_synced_height === null) {
              updateData.backward_synced_height = existing.last_synced_height;
            }
            if (existing.live_synced_height === null) {
              updateData.live_synced_height = existing.last_synced_height;
            }
            if (Object.keys(updateData).length > 0) {
              await this.pluginSyncStateRepository.update(
                { plugin_name: plugin.name },
                updateData,
              );
            }
            this.logger.debug(
              `Sync state already exists for plugin ${plugin.name}`,
            );
          }
        }
      } catch (error: any) {
        this.logger.error(
          `Failed to initialize sync state for plugin ${plugin.name}`,
          error,
        );
        throw error; // Fail fast - don't start indexing if plugin initialization fails
      }
    }

    this.logger.log(
      `Successfully initialized sync states for ${this.plugins.length} plugins`,
    );
  }

  /**
   * Auto-update plugin data for all registered plugins.
   * Processes plugins sequentially to avoid race conditions when updating the same transaction.
   */
  async autoUpdatePluginData(): Promise<void> {
    this.logger.log('Starting auto-update for all plugins...');

    for (const plugin of this.plugins) {
      try {
        this.logger.log(`[${plugin.name}] Starting auto-update`);
        await plugin.updateTransactions();
        this.logger.log(`[${plugin.name}] Auto-update completed`);
      } catch (error: any) {
        this.logger.error(
          `[${plugin.name}] Auto-update failed`,
          error.stack,
        );
        // Continue with other plugins even if one fails
      }
    }

    this.logger.log('Auto-update for all plugins completed');
  }
}
