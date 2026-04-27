import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Protects admin-only HTTP surfaces (Bull Board, debug endpoints,
 * operator-only writes). Accepts the key via either `x-admin-api-key` or
 * `Authorization: Bearer <key>` and uses constant-time comparison.
 *
 * The key is read from `process.env.ADMIN_API_KEY` at request time so the
 * guard reflects env updates without requiring a rebuild. If the key is
 * unset or too short the guard fails closed — it rejects every request
 * rather than falling back to permissive behaviour.
 */
@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided =
      (request.headers['x-admin-api-key'] as string | undefined) ||
      (request.headers['authorization'] as string | undefined)?.replace(
        /^Bearer\s+/i,
        '',
      );

    const expected = process.env.ADMIN_API_KEY;

    if (!expected || expected.length < 16) {
      // Fail closed: treat a missing/weak key as "no admin access at all".
      throw new UnauthorizedException(
        'Admin access is not configured on this server',
      );
    }
    if (!provided) {
      throw new UnauthorizedException('Admin API key is required');
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid admin API key');
    }
    return true;
  }
}
