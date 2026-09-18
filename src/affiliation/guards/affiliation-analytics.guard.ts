import {
  AFFILIATION_ANALYTICS_MIN_PASSWORD_LENGTH,
  AFFILIATION_ANALYTICS_PASSWORD,
  AFFILIATION_ANALYTICS_USER,
} from '@/configs/constants';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';

export const AFFILIATION_ANALYTICS_REALM = 'Superhero affiliation dashboards';

/**
 * Compare without leaking which characters — or how many — matched.
 *
 * Digesting first means both buffers are always 32 bytes, so `timingSafeEqual`
 * never throws on a length mismatch and the comparison leaks nothing about the
 * password's length either. (Comparing the raw strings would need an explicit
 * length check first, and that check is itself an oracle.)
 */
function safeEquals(provided: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(provided, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );
}

/**
 * Gate the internal affiliation dashboards behind HTTP Basic auth.
 *
 * These endpoints publish wallet address ↔ X handle ↔ follower count ↔ payout
 * amount ↔ transaction hash. That is a deanonymising join — an on-chain address
 * is pseudonymous until something ties it to a name — so it cannot sit on an
 * open URL.
 *
 * Basic auth suits an operator dashboard opened in a browser: the browser shows
 * its own credential prompt on the 401 challenge, caches the answer for the
 * session, and then attaches it to every later request to this origin —
 * including the page's own `fetch` calls for chart data, which is why the views
 * need no changes. Scripts use `curl -u user:password`. Nothing travels in a
 * URL, so nothing lands in access logs, `Referer`, bookmarks or history.
 */
@Injectable()
export class AffiliationAnalyticsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Fail closed when the deployment has no password. Deliberately NOT a 401
    // challenge: a browser would prompt, reject whatever is typed, and prompt
    // again forever, since no credential can satisfy an unset password. A 503
    // naming the variable ends that loop and tells the operator what to fix.
    if (
      !AFFILIATION_ANALYTICS_PASSWORD ||
      AFFILIATION_ANALYTICS_PASSWORD.length <
        AFFILIATION_ANALYTICS_MIN_PASSWORD_LENGTH
    ) {
      throw new ServiceUnavailableException(
        'Affiliation dashboards are not configured: set' +
          ` AFFILIATION_ANALYTICS_PASSWORD (min ${AFFILIATION_ANALYTICS_MIN_PASSWORD_LENGTH}` +
          ' chars) on the server.',
      );
    }

    const credentials = this.decodeBasic(request);
    if (!credentials) {
      this.challenge(response);
    }

    // Both comparisons run before the `&&`, so a wrong username and a wrong
    // password cost the same time. Short-circuiting here would let an attacker
    // discover the username by measuring which rejection came back faster.
    const userOk = safeEquals(credentials.user, AFFILIATION_ANALYTICS_USER);
    const passwordOk = safeEquals(
      credentials.password,
      AFFILIATION_ANALYTICS_PASSWORD,
    );
    if (!userOk || !passwordOk) {
      this.challenge(response);
    }

    return true;
  }

  private decodeBasic(
    request: Request,
  ): { user: string; password: string } | null {
    const header = request.headers.authorization;
    if (!header) {
      return null;
    }
    const separator = header.indexOf(' ');
    if (separator === -1) {
      return null;
    }
    if (header.slice(0, separator).toLowerCase() !== 'basic') {
      return null;
    }
    const decoded = Buffer.from(
      header.slice(separator + 1).trim(),
      'base64',
    ).toString('utf8');
    // Only the FIRST colon separates the two fields — a password may contain
    // colons, a username may not.
    const colon = decoded.indexOf(':');
    if (colon === -1) {
      return null;
    }
    return {
      user: decoded.slice(0, colon),
      password: decoded.slice(colon + 1),
    };
  }

  /**
   * Send the challenge that makes the browser show its credential prompt.
   * Returns `never` so callers can treat it as a terminator.
   */
  private challenge(response: Response): never {
    response.setHeader(
      'WWW-Authenticate',
      `Basic realm="${AFFILIATION_ANALYTICS_REALM}", charset="UTF-8"`,
    );
    throw new UnauthorizedException(
      'Authentication required for the affiliation dashboards.',
    );
  }
}
