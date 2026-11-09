import { Tx } from '../entities/tx.entity';
import { KeyBlock } from '../entities/key-block.entity';
import { SyncState } from '../entities/sync-state.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { EntityConfig } from '@/api-core/types/entity-config.interface';

// Full-history blockchain mirror tables: no range-filter alternative to
// OFFSET paging exists for these (unlike app tables, a client walking chain
// history has no other way to reach old rows), so they need a far higher
// cap than the base controller/resolver's default MAX_PAGE/MAX_GRAPHQL_PAGE
// (500) to stay usable for explorer/backfill clients.
const MDW_MIRROR_MAX_PAGE = 1_000_000;

export const TX_CONFIG: EntityConfig<Tx> = {
  entity: Tx,
  primaryKey: 'hash',
  defaultOrderBy: 'block_height',
  defaultOrderDirection: 'DESC',
  tableAlias: 'tx',
  routePrefix: 'v2/mdw/txs',
  queryNames: {
    plural: 'txs',
    singular: 'tx',
  },
  swaggerTag: 'MDW Transactions',
  maxPage: MDW_MIRROR_MAX_PAGE,
  orderByFields: [
    'hash',
    'block_hash',
    'block_height',
    'version',
    'micro_index',
    'micro_time',
    'type',
    'contract_id',
    'function',
    'caller_id',
    'sender_id',
    'recipient_id',
    'created_at',
  ],
  relations: [
    {
      field: 'keyBlock',
      relatedEntity: KeyBlock,
      returnType: () => KeyBlock,
      joinCondition: {
        localField: 'height',
        parentField: 'block_height',
      },
      isArray: false,
      nullable: true,
    },
  ],
};

export const KEY_BLOCK_CONFIG: EntityConfig<KeyBlock> = {
  entity: KeyBlock,
  primaryKey: 'hash',
  defaultOrderBy: 'height',
  defaultOrderDirection: 'DESC',
  tableAlias: 'key_block',
  routePrefix: 'v2/mdw/key-blocks',
  queryNames: {
    plural: 'keyBlocks',
    singular: 'keyBlock',
  },
  swaggerTag: 'MDW Key Blocks',
  maxPage: MDW_MIRROR_MAX_PAGE,
  orderByFields: [
    'height',
    'hash',
    'prev_hash',
    'prev_key_hash',
    'state_hash',
    'beneficiary',
    'miner',
    'time',
    'transactions_count',
    'micro_blocks_count',
    'beneficiary_reward',
    'nonce',
    'target',
    'version',
    'created_at',
  ],
  relations: [
    {
      field: 'txs',
      relatedEntity: Tx,
      returnType: () => [Tx],
      joinCondition: {
        localField: 'block_height',
        parentField: 'height',
      },
      isArray: true,
      nullable: false,
      filterableFields: ['type', 'function', 'sender_id'],
      defaultOrderBy: 'block_height',
      defaultOrderDirection: 'DESC',
    },
  ],
};

export const SYNC_STATE_CONFIG: EntityConfig<SyncState> = {
  entity: SyncState,
  primaryKey: 'id',
  defaultOrderBy: 'id',
  defaultOrderDirection: 'ASC',
  tableAlias: 'sync_state',
  routePrefix: 'v2/mdw/sync-state',
  queryNames: {
    plural: 'syncStates',
    singular: 'syncState',
  },
  swaggerTag: 'MDW Sync State',
  orderByFields: [
    'id',
    'last_synced_height',
    'tip_height',
    'is_bulk_mode',
    'backward_synced_height',
    'live_synced_height',
    'created_at',
    'updated_at',
  ],
};

export const PLUGIN_SYNC_STATE_CONFIG: EntityConfig<PluginSyncState> = {
  entity: PluginSyncState,
  primaryKey: 'plugin_name',
  defaultOrderBy: 'plugin_name',
  defaultOrderDirection: 'ASC',
  tableAlias: 'plugin_sync_state',
  routePrefix: 'v2/mdw/plugin-sync-state',
  queryNames: {
    plural: 'pluginSyncStates',
    singular: 'pluginSyncState',
  },
  swaggerTag: 'MDW Plugin Sync State',
  orderByFields: [
    'plugin_name',
    'version',
    'last_synced_height',
    'backward_synced_height',
    'live_synced_height',
    'start_from_height',
    'created_at',
    'updated_at',
  ],
};

export const ENTITY_CONFIGS = [
  TX_CONFIG,
  KEY_BLOCK_CONFIG,
  SYNC_STATE_CONFIG,
  PLUGIN_SYNC_STATE_CONFIG,
];
