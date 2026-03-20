import { resolveTrendingSymbolsForPost } from './token-mentions.util';

describe('resolveTrendingSymbolsForPost', () => {
  it('returns unique symbols from the post and its parent', async () => {
    const loadParentPost = jest.fn().mockResolvedValue({
      token_mentions: ['BETA', 'ALPHA'],
    });

    await expect(
      resolveTrendingSymbolsForPost(
        {
          post_id: 'parent-1',
          token_mentions: ['ALPHA', 'GAMMA'],
        } as any,
        loadParentPost,
      ),
    ).resolves.toEqual(['ALPHA', 'GAMMA', 'BETA']);

    expect(loadParentPost).toHaveBeenCalledWith('parent-1');
  });

  it('returns an empty array for missing posts', async () => {
    await expect(
      resolveTrendingSymbolsForPost(null, jest.fn()),
    ).resolves.toEqual([]);
  });
});
