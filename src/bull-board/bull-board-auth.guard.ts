import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { MODULE_CONFIG_TOKEN } from './bull-board.constants';
import { BullBoardModuleConfig } from './interfaces';

function parseBasicAuth(
  header: string | undefined,
): { user: string; password: string } | null {
  const match = /^Basic\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match) {
    return null;
  }
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) {
    return null;
  }
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

// Hashing first gives equal-length buffers, so the comparison does not leak
// the length of the expected value.
function safeEqual(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Browsers resend Basic credentials to this origin even when another site
// submits the request, and a plain form POST can add a job (the global
// urlencoded parser fills the body addJob reads). Requests without the header
// (curl, older browsers) keep working.
function isCrossSiteWrite(request: Request): boolean {
  if (SAFE_METHODS.has(request.method)) {
    return false;
  }
  const site = request.headers['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

/**
 * HTTP Basic auth for Bull Board. The controller's catch-all route serves the
 * UI, its assets and its JSON API, so this one guard covers all of them.
 */
@Injectable()
export class BullBoardAuthGuard implements CanActivate {
  constructor(
    @Inject(MODULE_CONFIG_TOKEN)
    private readonly moduleConfig: BullBoardModuleConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const { credentials } = this.moduleConfig.config;
    if (!credentials) {
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const provided = parseBasicAuth(request.headers.authorization);
    if (provided) {
      const userMatches = safeEqual(provided.user, credentials.user);
      const passwordMatches = safeEqual(
        provided.password,
        credentials.password,
      );
      if (userMatches && passwordMatches) {
        if (isCrossSiteWrite(request)) {
          throw new ForbiddenException();
        }
        return true;
      }
    }

    // Without the challenge header a browser shows the 401 instead of a login
    // prompt.
    http
      .getResponse<Response>()
      .setHeader(
        'WWW-Authenticate',
        'Basic realm="Bull Board", charset="UTF-8"',
      );
    throw new UnauthorizedException();
  }
}
