import { BadRequestException } from '@nestjs/common';
import {
  ENTITY_CONFIGS,
  KEY_BLOCK_CONFIG,
  TX_CONFIG,
} from '@/mdw-sync/config/entity-configs';
import {
  BLOCK_CONFIG,
  GENERATION_CONFIG,
  INCLUDE_GRAPH_CONFIGS,
  ITEM_CONFIG,
} from '@/test/harness/include-graph';
import { parseIncludesToTree } from './includes-parser';
import {
  createEntityConfigRegistry,
  validateIncludesTree,
} from './relation-loader';

// The two graphs share no entity, so neither reaches the other's configs.
const registry = createEntityConfigRegistry([
  ...ENTITY_CONFIGS,
  ...INCLUDE_GRAPH_CONFIGS,
]);

describe('validateIncludesTree', () => {
  const validate = (config: any, includes: string) => () =>
    validateIncludesTree(config, parseIncludesToTree(includes), registry);

  it.each([
    { config: KEY_BLOCK_CONFIG, includes: 'txs', joinsArray: true },
    { config: TX_CONFIG, includes: 'keyBlock', joinsArray: false },
    {
      config: KEY_BLOCK_CONFIG,
      includes: 'unknown,unknown.nested',
      joinsArray: false,
    },
    { config: GENERATION_CONFIG, includes: 'blocks', joinsArray: true },
    {
      config: GENERATION_CONFIG,
      includes: 'blocks,blocks.items',
      joinsArray: true,
    },
    { config: BLOCK_CONFIG, includes: 'generation,items', joinsArray: true },
    { config: BLOCK_CONFIG, includes: 'items.generation', joinsArray: true },
    { config: ITEM_CONFIG, includes: 'generation', joinsArray: false },
    { config: ITEM_CONFIG, includes: 'generation.blocks', joinsArray: true },
  ])(
    'accepts $includes on $config.routePrefix',
    ({ config, includes, joinsArray }) => {
      expect(validate(config, includes)()).toBe(joinsArray);
    },
  );

  it.each([
    { config: KEY_BLOCK_CONFIG, includes: 'txs.keyBlock' },
    {
      config: KEY_BLOCK_CONFIG,
      includes: 'txs.keyBlock.txs.keyBlock.txs.keyBlock.txs',
    },
    { config: TX_CONFIG, includes: 'keyBlock.txs' },
    { config: GENERATION_CONFIG, includes: 'blocks.generation' },
    { config: BLOCK_CONFIG, includes: 'generation.blocks' },
  ])(
    'rejects the cycle $includes on $config.routePrefix',
    ({ config, includes }) => {
      expect(validate(config, includes)).toThrow(BadRequestException);
      expect(validate(config, includes)).toThrow(/leads back to/);
    },
  );

  it.each([
    { config: GENERATION_CONFIG, includes: 'items,blocks' },
    { config: GENERATION_CONFIG, includes: 'items,blocks.items' },
    { config: BLOCK_CONFIG, includes: 'items,generation.items' },
  ])(
    'rejects the cross product $includes on $config.routePrefix',
    ({ config, includes }) => {
      expect(validate(config, includes)).toThrow(/cannot be combined/);
    },
  );
});
