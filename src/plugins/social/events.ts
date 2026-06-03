/**
 * Emitted after an existing post is reclassified as a comment on a parent post
 * (see PostPersistenceService.processExistingPostAsComment). Cross-cutting
 * consumers (e.g. the notifications module) subscribe to this so the post
 * author can be told.
 *
 * Owned by the social plugin; consumers import the name/type. The plugin
 * never imports the consumers.
 */
export const POST_COMMENT_CREATED_EVENT = 'social.post.commented';

export interface PostCommentCreatedEventPayload {
  /** Account that wrote the comment (notification subject). */
  commenterAddress: string;
  /** Account that authored the parent post (notification recipient). */
  postAuthorAddress: string;
  /** Parent post id (the one being commented on). */
  parentPostId: string;
  /** The comment post's id. */
  commentId: string;
  /** Comment tx hash, used as the dedup key. */
  txHash: string;
}
