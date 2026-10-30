import {
  JOURNEY_EVENT_SET,
  JOURNEY_LIMITS,
  JOURNEY_OTHER_PAGE,
} from './journey.constants';

/** One row as it is written to `journey_events`. Nothing else is stored. */
export type JourneyEventRow = {
  anon_id: string;
  event: string;
  page: string;
  occurred_at: Date;
};

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_PATTERN = /^\/[A-Za-z0-9/_:\-.()]*$/;
// Anything that looks like an on-chain account, contract, tx, oracle or name
// hash, or a long hex string. A route pattern never contains one, so a page
// that does was built from a real URL by mistake and must not be stored.
const CHAIN_ID = /(ak|ct|th|ok|nm)_[1-9A-HJ-NP-Za-km-z]{20,}/;
const HEX_ID = /0x[0-9a-fA-F]{16,}/;

/**
 * Reduce a client-supplied page to a safe route pattern. Anything unexpected
 * becomes `(other)` rather than being dropped, so the event still counts.
 */
export function sanitizeJourneyPage(value: unknown): string {
  if (typeof value !== 'string') {
    return JOURNEY_OTHER_PAGE;
  }
  if (value === JOURNEY_OTHER_PAGE) {
    return value;
  }
  if (
    value.length > JOURNEY_LIMITS.MAX_PAGE_LENGTH ||
    !PAGE_PATTERN.test(value) ||
    CHAIN_ID.test(value) ||
    HEX_ID.test(value)
  ) {
    return JOURNEY_OTHER_PAGE;
  }
  return value;
}

/**
 * Turn a raw request body into rows, or nothing.
 *
 * Never throws: the endpoint answers 204 whatever arrives, so bad input simply
 * yields an empty list. Accepts the raw text (beacons are sent as text/plain)
 * or an already-parsed object.
 */
export function parseJourneyPayload(
  body: unknown,
  now: number = Date.now(),
): JourneyEventRow[] {
  let payload: any = body;
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body);
    } catch {
      return [];
    }
  } else if (Buffer.isBuffer(body)) {
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return [];
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  if (payload.v !== 1) {
    return [];
  }
  if (typeof payload.a !== 'string' || !UUID_V4.test(payload.a)) {
    return [];
  }
  if (!Array.isArray(payload.e)) {
    return [];
  }

  const anonId = payload.a.toLowerCase();
  const earliest = now - JOURNEY_LIMITS.MAX_PAST_MS;
  const latest = now + JOURNEY_LIMITS.MAX_FUTURE_MS;
  const rows: JourneyEventRow[] = [];

  for (const item of payload.e.slice(
    0,
    JOURNEY_LIMITS.MAX_EVENTS_PER_REQUEST,
  )) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    if (typeof item.n !== 'string' || !JOURNEY_EVENT_SET.has(item.n)) {
      continue;
    }
    const t = item.t;
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      continue;
    }
    if (t < earliest || t > latest) {
      continue;
    }
    rows.push({
      anon_id: anonId,
      event: item.n,
      page: sanitizeJourneyPage(item.p),
      occurred_at: new Date(Math.round(t)),
    });
  }
  return rows;
}
