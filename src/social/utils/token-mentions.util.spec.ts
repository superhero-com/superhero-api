import {
  refreshTrendingScoresForPostSafely,
  resolveTrendingSymbolsForPost,
} from './token-mentions.util';

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

  it('refreshes trending scores using the resolved symbols', async () => {
    const loadParentPost = jest.fn().mockResolvedValue({
      token_mentions: ['BETA'],
    });
    const updateTrendingScoresForSymbols = jest
      .fn()
      .mockResolvedValue(undefined);
    const logError = jest.fn();

    await refreshTrendingScoresForPostSafely({
      post: {
        post_id: 'parent-1',
        token_mentions: ['ALPHA'],
      } as any,
      loadParentPost,
      updateTrendingScoresForSymbols,
      logError,
      errorMessage: 'refresh failed',
    });

    expect(updateTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
      'BETA',
    ]);
    expect(logError).not.toHaveBeenCalled();
  });

  it('logs and swallows refresh failures', async () => {
    const logError = jest.fn();

    await expect(
      refreshTrendingScoresForPostSafely({
        post: {
          post_id: null,
          token_mentions: ['ALPHA'],
        } as any,
        loadParentPost: jest.fn(),
        updateTrendingScoresForSymbols: jest
          .fn()
          .mockRejectedValue(new Error('boom')),
        logError,
        errorMessage: 'refresh failed',
      }),
    ).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith('refresh failed', expect.any(String));
  });
});
