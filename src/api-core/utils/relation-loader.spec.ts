import { BadRequestException } from '@nestjs/common';
import {
  ENTITY_CONFIGS,
  KEY_BLOCK_CONFIG,
  MICRO_BLOCK_CONFIG,
  TX_CONFIG,
} from '@/mdw-sync/config/entity-configs';
import { parseIncludesToTree } from './includes-parser';
import {
  createEntityConfigRegistry,
  validateIncludesTree,
} from './relation-loader';

const registry = createEntityConfigRegistry(ENTITY_CONFIGS);

describe('validateIncludesTree', () => {
  const validate = (config: any, includes: string) => () =>
    validateIncludesTree(config, parseIncludesToTree(includes), registry);

  it.each([
    { config: KEY_BLOCK_CONFIG, includes: 'txs', joinsArray: true },
    { config: KEY_BLOCK_CONFIG, includes: 'microBlocks', joinsArray: true },
    {
      config: KEY_BLOCK_CONFIG,
      includes: 'microBlocks,microBlocks.txs',
      joinsArray: true,
    },
    { config: MICRO_BLOCK_CONFIG, includes: 'keyBlock,txs', joinsArray: true },
    { config: MICRO_BLOCK_CONFIG, includes: 'txs.keyBlock', joinsArray: true },
    { config: TX_CONFIG, includes: 'keyBlock', joinsArray: false },
    { config: TX_CONFIG, includes: 'keyBlock.microBlocks', joinsArray: true },
    {
      config: KEY_BLOCK_CONFIG,
      includes: 'unknown,unknown.nested',
      joinsArray: false,
    },
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
    { config: KEY_BLOCK_CONFIG, includes: 'microBlocks.keyBlock' },
    { config: MICRO_BLOCK_CONFIG, includes: 'keyBlock.microBlocks' },
    { config: TX_CONFIG, includes: 'keyBlock.txs' },
  ])(
    'rejects the cycle $includes on $config.routePrefix',
    ({ config, includes }) => {
      expect(validate(config, includes)).toThrow(BadRequestException);
      expect(validate(config, includes)).toThrow(/leads back to/);
    },
  );

  it.each([
    { config: KEY_BLOCK_CONFIG, includes: 'txs,microBlocks' },
    { config: KEY_BLOCK_CONFIG, includes: 'txs,microBlocks.txs' },
    { config: MICRO_BLOCK_CONFIG, includes: 'txs,keyBlock.txs' },
  ])(
    'rejects the cross product $includes on $config.routePrefix',
    ({ config, includes }) => {
      expect(validate(config, includes)).toThrow(/cannot be combined/);
    },
  );
});
