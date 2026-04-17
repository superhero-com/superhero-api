import { TRENDING_TAGS_API_KEY } from '@/configs/constants';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey =
      (request.headers['x-api-key'] as string | undefined) ||
      (request.headers['authorization'] as string | undefined)?.replace(
        'Bearer ',
        '',
      );

    if (!apiKey) {
      throw new UnauthorizedException('API key is required');
    }

    // Reject outright if the server-side key is unset or too short so that a
    // misconfigured deployment cannot be bypassed by sending an empty key.
    if (!TRENDING_TAGS_API_KEY || TRENDING_TAGS_API_KEY.length < 16) {
      throw new UnauthorizedException('API key authentication is not configured');
    }

    // Constant-time comparison prevents timing side channels.
    const provided = Buffer.from(apiKey);
    const expected = Buffer.from(TRENDING_TAGS_API_KEY);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
