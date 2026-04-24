import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BasePlugin } from '../base-plugin';
import { PluginFilter } from '../plugin.interface';
import { GovernancePluginSyncService } from './governance-plugin-sync.service';
import { GovernancePollRegistry } from './services/governance-poll-registry.service';
import {
  getContractAddress,
  getStartHeight,
  GOVERNANCE_CONTRACT,
} from './config/governance.config';

@Injectable()
export class GovernancePlugin extends BasePlugin {
  protected readonly logger = new Logger(GovernancePlugin.name);
  readonly name = 'governance';
  readonly version = 2;

  constructor(
    @InjectRepository(Tx)
    protected readonly txRepository: Repository<Tx>,
    @InjectRepository(PluginSyncState)
    protected readonly pluginSyncStateRepository: Repository<PluginSyncState>,
    private governancePluginSyncService: GovernancePluginSyncService,
    private readonly configService: ConfigService,
    private readonly pollRegistry: GovernancePollRegistry,
  ) {
    super();
  }

  startFromHeight(): number {
    const config = this.configService.get<{
      contract: { startHeight: number };
    }>('governance');
    return config?.contract?.startHeight ?? getStartHeight();
  }

  filters(): PluginFilter[] {
    const config = this.configService.get<{
      contract: { contractAddress: string };
    }>('governance');
    const contractAddress =
      config?.contract?.contractAddress ?? getContractAddress();

    if (!contractAddress) {
      this.logger.warn('[Governance] No contract address configured');
      return [];
    }

    // Governance touches three classes of transactions. We match each class
    // as narrowly as possible so we only persist governance-relevant rows:
    //
    //   1. ContractCallTx on the governance REGISTRY contract. This covers
    //      add_poll / delegate / revoke_delegation and is identified by the
    //      well-known registry contract_id.
    //
    //   2. ContractCallTx for vote / revoke_vote on a KNOWN poll contract.
    //      Poll contract addresses are not fixed at build time — they are
    //      discovered at runtime via `add_poll` events and tracked by
    //      `GovernancePollRegistry`. Matching by function name alone would
    //      over-index arbitrary contracts that expose a generic `vote` /
    //      `revoke_vote` entrypoint, so contract_id must be a known poll.
    //
    //   3. ContractCreateTx for a KNOWN poll contract. In chain order the
    //      deployment precedes its registry `add_poll` call, so this
    //      predicate typically doesn't match at ingest time; the add_poll
    //      handler backfills the deployment from MDW once the poll is
    //      registered (see GovernancePluginSyncService). We still match
    //      here so that replayed / re-ingested CreateTx rows for already-
    //      known polls are accepted without a round-trip to MDW.
    return [
      {
        predicate: (tx: Partial<Tx>) => {
          if (!tx.contract_id) {
            return false;
          }
          if (
            tx.type === 'ContractCallTx' &&
            tx.contract_id === contractAddress
          ) {
            return true;
          }
          if (
            tx.type === 'ContractCallTx' &&
            (tx.function === GOVERNANCE_CONTRACT.FUNCTIONS.vote ||
              tx.function === GOVERNANCE_CONTRACT.FUNCTIONS.revoke_vote) &&
            this.pollRegistry.has(tx.contract_id)
          ) {
            return true;
          }
          if (
            tx.type === 'ContractCreateTx' &&
            this.pollRegistry.has(tx.contract_id)
          ) {
            return true;
          }
          return false;
        },
      },
    ];
  }

  protected getSyncService(): GovernancePluginSyncService {
    return this.governancePluginSyncService;
  }

  /**
   * Get queries to retrieve transactions that need auto-updating.
   * Default implementation extracts contract IDs from filters and creates a query.
   * Plugins can override this method to provide custom queries.
   * @param pluginName - The plugin name
   * @param currentVersion - The current plugin version
   * @returns Array of query functions that return transactions needing updates
   */
  getUpdateQueries(
    pluginName: string,
    currentVersion: number,
  ): Array<
    (
      repository: Repository<Tx>,
      limit: number,
      cursor?: { block_height: number; micro_time: string },
    ) => Promise<Tx[]>
  > {
    const supportedFunctions = Object.values(GOVERNANCE_CONTRACT.FUNCTIONS);

    return [
      async (repo, limit, cursor) => {
        const query = repo
          .createQueryBuilder('tx')
          .where('tx.function IN (:...supportedFunctions)', {
            supportedFunctions,
          })
          .andWhere(
            `(tx.data->>'${pluginName}' IS NULL OR (tx.data->'${pluginName}'->>'_version')::int != :version)`,
            { version: currentVersion },
          );

        // Apply cursor for pagination (cursor-based instead of offset-based)
        if (cursor) {
          query.andWhere(
            '(tx.block_height > :cursorHeight OR (tx.block_height = :cursorHeight AND tx.micro_time > :cursorMicroTime))',
            {
              cursorHeight: cursor.block_height,
              cursorMicroTime: cursor.micro_time,
            },
          );
        }

        return query
          .orderBy('tx.block_height', 'ASC')
          .addOrderBy('tx.micro_time', 'ASC')
          .take(limit)
          .getMany();
      },
    ];
  }
}
