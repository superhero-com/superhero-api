import { Post } from '../entities/post.entity';

export async function resolveTrendingSymbolsForPost(
  post: Pick<Post, 'post_id' | 'token_mentions'> | null | undefined,
  loadParentPost: (
    postId: string,
  ) => Promise<Pick<Post, 'token_mentions'> | null | undefined>,
): Promise<string[]> {
  if (!post) {
    return [];
  }

  const symbols = new Set<string>((post.token_mentions || []).filter(Boolean));

  if (!post.post_id) {
    return [...symbols];
  }

  const parentPost = await loadParentPost(post.post_id);
  (parentPost?.token_mentions || [])
    .filter(Boolean)
    .forEach((symbol) => symbols.add(symbol));

  return [...symbols];
}

export async function refreshTrendingScoresForPostSafely(options: {
  post: Pick<Post, 'post_id' | 'token_mentions'> | null | undefined;
  loadParentPost: (
    postId: string,
  ) => Promise<Pick<Post, 'token_mentions'> | null | undefined>;
  updateTrendingScoresForSymbols: (symbols: string[]) => Promise<void>;
  logError: (message: string, trace?: string) => void;
  errorMessage: string;
}): Promise<void> {
  const {
    post,
    loadParentPost,
    updateTrendingScoresForSymbols,
    logError,
    errorMessage,
  } = options;

  try {
    const affectedSymbols = await resolveTrendingSymbolsForPost(
      post,
      loadParentPost,
    );
    await updateTrendingScoresForSymbols(affectedSymbols);
  } catch (error) {
    logError(
      errorMessage,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
