import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  AFFILIATION_DASHBOARD_COOKIE,
  AffiliationDashboardAuthService,
} from '../services/affiliation-dashboard-auth.service';

/** Where an unauthenticated browser is sent. */
export const AFFILIATION_DASHBOARD_LOGIN_PATH =
  '/api/bcl-affiliation/auth/login';
export const AFFILIATION_DASHBOARD_SETUP_PATH =
  '/api/bcl-affiliation/auth/setup';

/**
 * Read one cookie without `cookie-parser`, which this app does not register.
 */
export function readCookie(request: Request, name: string): string | undefined {
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
      return undefined;
    }
  }
  return undefined;
}

/**
 * Gate the internal affiliation dashboards behind an operator login.
 *
 * These endpoints publish wallet address ↔ X handle ↔ follower count ↔ payout
 * amount ↔ transaction hash. That is a deanonymising join — an on-chain address
 * is pseudonymous until something ties it to a name — so it cannot sit on an
 * open URL.
 *
 * A page navigation is redirected to the login (or, before anyone has claimed
 * the deployment, to setup) so an operator sees a form rather than a JSON
 * error. A data request from the already-loaded page gets a plain 401, because
 * redirecting a `fetch` to an HTML page just produces a confusing parse error
 * in the console instead of an honest failure.
 */
@Injectable()
export class AffiliationAnalyticsGuard implements CanActivate {
  constructor(private readonly authService: AffiliationDashboardAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const token = readCookie(request, AFFILIATION_DASHBOARD_COOKIE);
    if (await this.authService.resolveSession(token)) {
      return true;
    }

    const target = (await this.authService.needsSetup())
      ? AFFILIATION_DASHBOARD_SETUP_PATH
      : AFFILIATION_DASHBOARD_LOGIN_PATH;

    if (this.wantsHtml(request)) {
      response.redirect(302, target);
      // Nest still needs a falsy return or a throw to stop the handler; the
      // response is already committed, so throwing here would try to write a
      // body onto a finished redirect.
      return false;
    }

    throw new UnauthorizedException(
      `Not signed in. Open ${target} in a browser.`,
    );
  }

  /**
   * Distinguish a browser navigating to a page from the page's own `fetch`.
   * `Sec-Fetch-Mode: navigate` is the reliable signal in modern browsers; the
   * Accept header is the fallback for anything that does not send it.
   */
  private wantsHtml(request: Request): boolean {
    if (request.headers['sec-fetch-mode'] === 'navigate') {
      return true;
    }
    if (request.headers['sec-fetch-mode']) {
      // Present but not a navigation — this is a fetch/XHR/subresource.
      return false;
    }
    const accept = String(request.headers.accept || '');
    return accept.includes('text/html');
  }
}
