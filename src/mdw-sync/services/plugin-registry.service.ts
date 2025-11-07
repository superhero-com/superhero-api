import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Plugin, PluginFilter } from '../plugins/plugin.interface';
import { MDW_PLUGIN } from '../plugins/plugin.tokens';

@Injectable()
export class PluginRegistryService {
  private readonly logger = new Logger(PluginRegistryService.name);
  private plugins: Plugin[] = [];

  constructor(@Inject(MDW_PLUGIN) private readonly pluginProviders: Plugin[]) {
    this.plugins = pluginProviders || [];
    this.logger.log(`Registered ${this.plugins.length} plugins`);
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
}
