import { parseIncludesToTree } from './includes-parser';

describe('parseIncludesToTree', () => {
  it('builds a tree from comma-separated dotted paths', () => {
    expect(parseIncludesToTree(' txs , txs.keyBlock,,microBlocks. ,')).toEqual({
      txs: { keyBlock: {} },
      microBlocks: {},
    });
  });

  it.each([
    '__proto__.polluted',
    'constructor.prototype.polluted',
    '__proto__.__proto__.polluted',
  ])('keeps %s off Object.prototype', (includes) => {
    try {
      parseIncludesToTree(includes);
      expect(({} as any).polluted).toBeUndefined();
    } finally {
      delete (Object.prototype as any).polluted;
    }
  });
});
