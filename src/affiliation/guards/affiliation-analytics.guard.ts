import {
  AFFILIATION_ANALYTICS_API_KEY,
  AFFILIATION_ANALYTICS_MIN_KEY_LENGTH,
} from '@/configs/constants';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';

export const AFFILIATION_ANALYTICS_COOKIE = 'sh_affiliation_analytics';

/** Long enough for a working session, short enough that a shared laptop
 *  does not stay authorised for a week. */
const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Read one cookie without pulling in `cookie-parser`, which this app does not
 * register.
 */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed cookie is simply not a valid key.
      return undefined;
    }
  }
  return undefined;
}

function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so the length must be compared
  // first. That leaks the key's length and nothing else.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Gate the internal affiliation dashboards behind an operator key.
 *
 * These endpoints publish wallet address ↔ X handle ↔ follower count ↔ payout
 * amount ↔ transaction hash. That is a deanonymising join — an on-chain address
 * is pseudonymous until something ties it to a name — so it cannot sit on an
 * open URL.
 *
 * The key is accepted three ways because a dashboard is opened in a browser,
 * which cannot attach a header to a navigation:
 *   1. `x-api-key` / `Authorization: Bearer` — scripts and curl.
 *   2. `?key=…` — the operator pastes the dashboard URL once.
 *   3. a cookie this guard sets after 1 or 2 succeeds, so the page's own XHR
 *      and any later refresh work without the key in the URL bar.
 *
 * A query-string key can land in access logs and in `Referer`, which is why it
 * is traded for a cookie immediately; treat the key as an operator secret to
 * rotate, not a password to hand out.
 */
@Injectable()
export class AffiliationAnalyticsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Fail closed. A deployment that forgot the variable must show locked
    // dashboards, never open ones — and must say which variable is missing,
    // because a silently dark dashboard gets "fixed" by removing the guard.
    if (
      !AFFILIATION_ANALYTICS_API_KEY ||
      AFFILIATION_ANALYTICS_API_KEY.length <
        AFFILIATION_ANALYTICS_MIN_KEY_LENGTH
    ) {
      throw new UnauthorizedException(
        'Affiliation dashboards are not configured: set' +
          ` AFFILIATION_ANALYTICS_API_KEY (min ${AFFILIATION_ANALYTICS_MIN_KEY_LENGTH}` +
          ' chars) on the server.',
      );
    }

    const cookieKey = readCookie(request, AFFILIATION_ANALYTICS_COOKIE);
    if (
      cookieKey &&
      constantTimeEquals(cookieKey, AFFILIATION_ANALYTICS_API_KEY)
    ) {
      return true;
    }

    const headerKey =
      (request.headers['x-api-key'] as string | undefined) ||
      (request.headers['authorization'] as string | undefined)?.replace(
        /^Bearer /,
        '',
      );
    const queryKey =
      typeof request.query?.key === 'string' ? request.query.key : undefined;
    const presented = headerKey || queryKey;

    if (
      !presented ||
      !constantTimeEquals(presented, AFFILIATION_ANALYTICS_API_KEY)
    ) {
      throw new UnauthorizedException(
        'A valid operator key is required for the affiliation dashboards.',
      );
    }

    // Trade the key for a session cookie so it stops travelling in URLs.
    if (queryKey && typeof response?.cookie === 'function') {
      response.cookie(
        AFFILIATION_ANALYTICS_COOKIE,
        AFFILIATION_ANALYTICS_API_KEY,
        {
          httpOnly: true,
          sameSite: 'lax',
          // Only mark Secure when the request actually arrived over TLS. Setting
          // it unconditionally would silently drop the cookie on a plain-HTTP
          // deployment and make the dashboards look broken.
          secure:
            request.secure || request.headers['x-forwarded-proto'] === 'https',
          maxAge: COOKIE_MAX_AGE_MS,
          path: '/api',
        },
      );
    }

    return true;
  }
}
