/**
 * Emitted after a genuinely new follow edge is inserted from a live Followed
 * event by the graph outbox. Cross-cutting consumers (the
 * notifications module) subscribe so the followed account can be told.
 *
 * Owned by the social-graph plugin; consumers import the name/type. The plugin
 * never imports the consumers.
 */
export const SOCIAL_GRAPH_FOLLOWED_EVENT = 'social-graph.followed';

export interface SocialGraphFollowedEventPayload {
  /** Graph namespace; optional for historical notification compatibility. */
  graphScope?: { network: string; contract: string; eventIndex: number };
  /** Account that started following (notification subject). */
  followerAddress: string;
  /** Account that was followed (notification recipient). */
  followedAddress: string;
  /** Follow tx hash, used as the dedup key. */
  txHash: string;
}
