import { Post } from '@/social/entities/post.entity';

/**
 * Whether a tip should be treated as a self-tip (ignored for storage and scoring).
 * - Post tip: sender matches the post author.
 * - Profile tip: sender and receiver are the same account.
 */
export function isSelfTip(
  senderAddress: string,
  receiverAddress: string,
  post: Pick<Post, 'sender_address'> | null,
): boolean {
  if (post) {
    return senderAddress === post.sender_address;
  }

  return senderAddress === receiverAddress;
}
