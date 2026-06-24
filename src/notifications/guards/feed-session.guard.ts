import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { extractBearerToken } from '../notifications.constants';
import { FeedSessionService } from '../services/feed-session.service';

/**
 * Authorizes web-feed reads/mutations. Requires `Authorization: Bearer <token>`
 * (a header, never a cookie — the API has no cookie auth and this keeps it
 * CSRF-immune), resolves the token to its owner address, and asserts that
 * address equals the `:address` route param. So a valid session for ak_A can
 * only ever touch ak_A's feed.
 */
@Injectable()
export class FeedSessionGuard implements CanActivate {
  constructor(private readonly sessions: FeedSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing feed session token');
    }

    const owner = await this.sessions.resolve(token);
    if (!owner) {
      throw new UnauthorizedException('Invalid or expired feed session');
    }

    const address = request.params?.address;
    if (!address || owner !== address) {
      throw new UnauthorizedException(
        'Feed session does not match the requested address',
      );
    }
    return true;
  }
}
