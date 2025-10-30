import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { MdwPlugin, MdwPluginFilter } from '../plugins/mdw-plugin.interface';
import { MDW_PLUGIN } from '../plugins/plugin.tokens';

@Injectable()
export class PluginRegistryService {
  private readonly logger = new Logger(PluginRegistryService.name);
  private plugins: MdwPlugin[] = [];

  constructor(
    @Inject(MDW_PLUGIN) private readonly pluginProviders: MdwPlugin[],
  ) {
    this.plugins = pluginProviders || [];
    this.logger.log(`Registered ${this.plugins.length} plugins`);
  }

  getPlugins(): MdwPlugin[] {
    return this.plugins;
  }

  getPluginByName(name: string): MdwPlugin | undefined {
    return this.plugins.find((plugin) => plugin.name === name);
  }

  getAllFilters(): MdwPluginFilter[] {
    const allFilters: MdwPluginFilter[] = [];

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
