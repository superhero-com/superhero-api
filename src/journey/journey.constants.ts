/**
 * Shared contract for the anonymous user-journey analytics.
 *
 * The web app sends `{ v: 1, a: <uuid v4>, e: [{ n, p, t }] }` to
 * `POST /api/analytics/journey/events`. Everything here is the server side of
 * that contract: the closed list of event names, the funnels built from them,
 * and the limits the ingest enforces. The web app exports the same event list;
 * a name that is not in it is dropped on the floor.
 */

/** Closed allowlist. Anything else in a payload is dropped. */
export const JOURNEY_EVENTS = [
  // Page
  'page_view',
  // Profile / onboarding flow
  'profile_view',
  'profile_edit_open',
  'claim_account_open',
  'claim_account_done',
  'x_connect_start',
  'x_connected',
  'post_created',
  'token_created',
  // Wallet
  'wallet_connect_open',
  'wallet_connected',
  'wallet_created',
  // Trade / DeFi
  'token_view',
  'token_buy_done',
  'token_sell_done',
  'swap_done',
  'liquidity_added',
  // Social
  'tip_sent',
  'reply_created',
  // Chat / governance
  'chat_message_sent',
  'governance_vote_done',
] as const;

export type JourneyEventName = (typeof JOURNEY_EVENTS)[number];

export const JOURNEY_EVENT_SET: ReadonlySet<string> = new Set(JOURNEY_EVENTS);

export type JourneyFunnelStep = { label: string; event: JourneyEventName };
export type JourneyFunnel = {
  id: string;
  label: string;
  steps: JourneyFunnelStep[];
};

/** Server-defined funnels. The first one is the dashboard default. */
export const JOURNEY_FUNNELS: JourneyFunnel[] = [
  {
    id: 'onboarding',
    label: 'Profile onboarding',
    steps: [
      { label: 'Profile page', event: 'profile_view' },
      { label: 'Clicked Edit', event: 'profile_edit_open' },
      { label: 'Claim Superhero account', event: 'claim_account_open' },
      { label: 'Connect X', event: 'x_connect_start' },
      { label: 'X connected', event: 'x_connected' },
      { label: 'Posted', event: 'post_created' },
      { label: 'Created a token', event: 'token_created' },
    ],
  },
  {
    id: 'wallet',
    label: 'Wallet connect',
    steps: [
      { label: 'Any page', event: 'page_view' },
      { label: 'Open connect wallet', event: 'wallet_connect_open' },
      { label: 'Wallet connected', event: 'wallet_connected' },
      { label: 'Posted', event: 'post_created' },
    ],
  },
  {
    id: 'trade',
    label: 'Token trading',
    steps: [
      { label: 'Token page', event: 'token_view' },
      { label: 'Bought', event: 'token_buy_done' },
      { label: 'Sold', event: 'token_sell_done' },
    ],
  },
  {
    id: 'create',
    label: 'Token creation',
    steps: [
      { label: 'Any page', event: 'page_view' },
      { label: 'Wallet connected', event: 'wallet_connected' },
      { label: 'Created a token', event: 'token_created' },
    ],
  },
];

export const DEFAULT_JOURNEY_FUNNEL_ID = JOURNEY_FUNNELS[0].id;

export const JOURNEY_LIMITS = {
  /** Events kept from one request; the rest are ignored. */
  MAX_EVENTS_PER_REQUEST: 50,
  /** Request bodies above this are dropped unread. */
  MAX_BODY: '16kb',
  /** `p` longer than this is rewritten to `(other)`. */
  MAX_PAGE_LENGTH: 96,
  /** Client timestamps older than this are dropped. */
  MAX_PAST_MS: 24 * 60 * 60 * 1000,
  /** Client timestamps further in the future than this are dropped. */
  MAX_FUTURE_MS: 5 * 60 * 1000,
  /** Flush the buffer at least this often. */
  FLUSH_INTERVAL_MS: 5000,
  /** Flush as soon as this many rows are waiting. */
  FLUSH_AT_ROWS: 500,
  /** Rows written by one INSERT (4 params each, far below the 65535 limit). */
  MAX_ROWS_PER_INSERT: 2000,
  /** Hard cap on buffered rows; anything above is dropped. */
  MAX_BUFFERED_ROWS: 20000,
  /** Rows older than this are deleted by the daily retention job. */
  RETENTION_DAYS: 180,
  /** Dashboard default and maximum query ranges. */
  DEFAULT_RANGE_DAYS: 30,
  MAX_RANGE_DAYS: 180,
  /** A page view with no next page view within this window is an exit. */
  VISIT_GAP_MINUTES: 30,
} as const;

export const JOURNEY_OTHER_PAGE = '(other)';
