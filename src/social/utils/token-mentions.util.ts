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
